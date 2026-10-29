'use strict';

// Live channels as HLS, for cast devices (Chromecast, Apple TV): they can't
// play the raw MPEG-TS most portals send. While a channel is being cast, it's
// read from this server's own /proxy/stream/<id> — which resolves the portal
// link, goes through the live buffer, and (as this isn't a browser) passes the
// codecs through as they are — and cut into HLS pieces in memory by the
// segmenter (TsSegmenter.js). No FFmpeg, no re-encode, no temp files.
//
// When the source drops (a restart at the portal), the reader opens it again
// and the playlist carries on after an #EXT-X-DISCONTINUITY, so the TV keeps
// playing. A session ends once the device stops asking for it; the next
// request starts it again. One whose source stopped answering (the reader gave
// up) isn't started again for the TV: its asks fail until it stops asking, or
// the app asks for a new cast link (retry()). Each holds a dozen pieces in memory — for 4K that's
// a lot — so there are at most a few (in Solo, on a phone, one channel and
// fewer, smaller pieces: config.js), and a stopped one lets go at once.
//
// An HLS channel whose segments the segmenter can't cut (encrypted, or fMP4)
// is passed through: playlist() answers null, and the route sends the TV to
// the channel's own HLS on this server, which it plays itself.

const log = require('../logger');
const { TsSegmenter } = require('./TsSegmenter');
const { readSelfStream } = require('./selfStreamReader');
const TAG = 'cast';

// seg + its number, as the segmenter names its pieces.
const SEGMENT = /^seg\d{1,20}\.ts$/;

class CastHls {
  /**
   * @param {object} o
   * @param {(channelId: string) => string} o.inputUrlFor  this server's own stream URL for a channel
   * @param {string} [o.userAgent]       what this server reads its own stream as
   * @param {number} [o.idleMs]          a session no one asked for in this long is stopped
   * @param {number} [o.startTimeoutMs]  how long an ask waits for the first piece
   * @param {number} [o.maxSessions]     channels cast at once; the least recently used gives way
   * @param {number} [o.windowSize]      pieces in each channel's playlist (TsSegmenter)
   * @param {typeof readSelfStream} [o.reader]
   */
  constructor({ inputUrlFor, userAgent = null, idleMs = 30_000, startTimeoutMs = 20_000, maxSessions = 3, windowSize = 10,
    maxPieceBytes = 32 * 1024 * 1024, now = Date.now, reader = readSelfStream } = {}) {
    this._inputUrlFor = inputUrlFor;
    this._userAgent = userAgent;
    this._idleMs = idleMs;
    this._startTimeoutMs = startTimeoutMs;
    this._maxSessions = maxSessions;
    this._windowSize = windowSize;
    this._maxPieceBytes = maxPieceBytes;
    this._now = now;
    this._reader = reader;
    this._sessions = new Map();   // channelId → { seg, ctrl, lastUsed, waiters }
    this._gaveUp = new Map();     // channelId → when the TV last asked, for a channel that stopped answering
    this._sweeper = setInterval(() => this._sweep(), Math.max(1000, Math.min(idleMs, 10_000)));
    this._sweeper.unref?.();
  }

  /** Casting needs nothing outside this server. */
  available() { return true; }

  /**
   * The channel's playlist, once its first piece is ready (starting it if
   * needed) — or null for a channel passed through as it is.
   */
  playlist(channelId) {
    const id = String(channelId);
    if (!this._sessions.has(id) && this._gaveUp.has(id)) {
      this._gaveUp.set(id, this._now());
      return Promise.reject(new Error('The channel stopped answering'));
    }
    const s = this._sessions.get(id) ?? this._start(id);
    s.lastUsed = this._now();
    if (s.passthrough) return Promise.resolve(null);
    const text = s.seg.playlist();
    if (text) return Promise.resolve(text);
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      // Only this ask gives up: the reader carries on, so the TV's next ask
      // may find the first piece (a 4K channel can take a while). The session
      // ends the usual ways — no one asks any more, or its source gives up.
      w.timer = setTimeout(() => {
        s.waiters = s.waiters.filter((x) => x !== w);
        reject(new Error('The channel took too long to start'));
      }, this._startTimeoutMs);
      w.timer.unref?.();
      s.waiters.push(w);
    });
  }

  /** A piece's bytes, or null (no such session, or a name that isn't one of its pieces). */
  segment(channelId, name) {
    const s = this._sessions.get(String(channelId));
    if (!s || !SEGMENT.test(String(name))) return null;
    s.lastUsed = this._now();
    return s.seg?.segment(String(name)) ?? null;
  }

  /** The stream types of a channel being cast (for the log when a device can't play it), or null. */
  codecsOf(channelId) {
    return this._sessions.get(String(channelId))?.seg?.codecs ?? null;
  }

  /** The channel's session ended now (the sender stopped casting it, or moved on). */
  stop(channelId, why = 'stopped') {
    this._gaveUp.delete(String(channelId));
    this._stop(String(channelId), why);
  }

  /** A new cast of the channel: one that stopped answering is tried again on the TV's next ask. */
  retry(channelId) { this._gaveUp.delete(String(channelId)); }

  /** Every session ended (on shutdown). */
  stopAll() {
    for (const id of [...this._sessions.keys()]) this._stop(id, 'shutdown');
    this._gaveUp.clear();
    clearInterval(this._sweeper);
  }

  get size() { return this._sessions.size; }

  _start(id) {
    while (this._sessions.size >= this._maxSessions) {
      const oldest = [...this._sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
      this._stop(oldest, 'room for another channel');
    }
    log.info(TAG, `ch ${id}: casting as HLS`);
    const s = { seg: new TsSegmenter({ now: this._now, windowSize: this._windowSize, maxPieceBytes: this._maxPieceBytes }), ctrl: new AbortController(), lastUsed: this._now(), waiters: [], passthrough: null };
    this._sessions.set(id, s);
    const current = () => this._sessions.get(id) === s;
    this._reader(this._inputUrlFor(id), {
      userAgent: this._userAgent,
      signal: s.ctrl.signal,
      onData: (buf) => {
        if (!current() || !s.seg) return;
        s.seg.push(buf);
        if (s.waiters.length) {
          const text = s.seg.playlist();
          if (text) for (const w of s.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(text); }
        }
      },
      onBreak: () => {
        if (!current() || !s.seg) return;
        log.info(TAG, `ch ${id}: the source broke off — reopening it`);
        s.seg.discontinuity();
      },
      // Kept as a passthrough session (no pieces) until the idle sweep, so
      // the TV's next ask is answered at once.
      onUnsupported: (why) => {
        if (!current()) return;
        log.info(TAG, `ch ${id}: ${why} — the TV plays the channel's own HLS`);
        s.passthrough = why;
        s.seg = null;
        for (const w of s.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
      },
    }).then(
      () => { if (current() && !s.passthrough) this._stop(id, 'its source ended'); },
      (e) => {
        if (!current()) return;
        if (e.gaveUp) this._gaveUp.set(id, this._now());
        this._stop(id, `its source failed: ${e.message}`);
      },
    );
    return s;
  }

  _stop(id, why) {
    const s = this._sessions.get(id);
    if (!s) return;
    this._sessions.delete(id);
    log.info(TAG, `ch ${id}: cast stream stopped — ${why}`);
    s.ctrl.abort();
    s.seg = null;   // its pieces go now, not when the reader lets go
    for (const w of s.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(`The channel stopped before it could be cast (${why})`));
    }
  }

  _sweep() {
    const t = this._now();
    for (const [id, s] of this._sessions) if (t - s.lastUsed > this._idleMs) this._stop(id, 'no longer watched');
    for (const [id, at] of this._gaveUp) if (t - at > this._idleMs) this._gaveUp.delete(id);
  }
}

module.exports = { CastHls, SEGMENT };
