'use strict';

// Live channels as HLS, for cast devices (Chromecast, Apple TV): they can't
// play the raw MPEG-TS most portals send. While a channel is being cast,
// FFmpeg reads it from this server's own /proxy/stream/<id> — which resolves
// the portal link (and, as this isn't a browser, passes the codecs through as
// they are) — and only re-wraps it into HLS segments in a temp folder (no
// re-encode, so little CPU). A session ends once the device stops asking for
// it, or when its FFmpeg exits; the next request starts it again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const log = require('../logger');
const TAG = 'cast';

// seg + its number — the clock's (YYYYMMDDhhmmss…), see -hls_start_number_source.
const SEGMENT = /^seg\d{1,20}\.ts$/;

/**
 * FFmpeg's arguments: copy the streams, 4 s segments, the last 10 listed, old
 * ones deleted. `append`: carry on a session whose source ended (its playlist
 * kept, a discontinuity marked before the new segments).
 */
function hlsArgs(inputUrl, dir, { userAgent = null, append = false } = {}) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    ...(userAgent ? ['-user_agent', userAgent] : []),
    // No -reconnect_at_eof: for an HLS channel the input is a playlist, which
    // ends after every download — FFmpeg then re-requested it ~10 times a
    // second, burning portal tokens until the source answered 403. A source
    // that really ends (an MPEG-TS pipe at a restart) makes FFmpeg exit, and
    // the session starts it again (see _spawn).
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-fflags', '+genpts',
    '-i', inputUrl,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '10',
    '-hls_flags', `delete_segments+independent_segments+omit_endlist${append ? '+append_list+discont_start' : ''}`,
    // Numbered by the clock: a session started again carries on from the
    // TV's last segment number instead of going back to 0.
    '-hls_start_number_source', 'datetime',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'),
  ];
}

class CastHls {
  /**
   * @param {object} o
   * @param {(channelId: string) => string} o.inputUrlFor  this server's own stream URL for a channel
   * @param {string} [o.root]            where the sessions' folders go
   * @param {number} [o.idleMs]          a session no one asked for in this long is stopped
   * @param {number} [o.startTimeoutMs]  how long a first playlist may take
   * @param {number} [o.maxSessions]     channels cast at once; the least recently used gives way
   */
  constructor({ inputUrlFor, root = path.join(os.tmpdir(), 'stalkerweb-cast'), idleMs = 30_000, startTimeoutMs = 20_000,
    maxSessions = 3, spawn = childProcess.spawn, now = Date.now, pollMs = 250, available = () => true, userAgent = null,
    maxRestartsPerMinute = 5 } = {}) {
    this._inputUrlFor = inputUrlFor;
    this._userAgent = userAgent;
    this._maxRestarts = maxRestartsPerMinute;
    this.available = available;
    this._root = root;
    this._idleMs = idleMs;
    this._startTimeoutMs = startTimeoutMs;
    this._maxSessions = maxSessions;
    this._spawn = spawn;
    this._now = now;
    this._pollMs = pollMs;
    this._sessions = new Map();   // channelId → { proc, dir, lastUsed, exited }
    this._sweeper = setInterval(() => this._sweep(), Math.max(1000, Math.min(idleMs, 10_000)));
    this._sweeper.unref?.();
  }

  /** The channel's playlist file, once FFmpeg has written its first one (starting it if needed). */
  async playlist(channelId) {
    const id = String(channelId);
    const s = this._sessions.get(id) ?? this._start(id);
    s.lastUsed = this._now();
    const file = path.join(s.dir, 'index.m3u8');
    const deadline = this._now() + this._startTimeoutMs;
    while (!fs.existsSync(file)) {
      if (s.exited) throw new Error(`The channel stopped before it could be cast${s.lastError ? ` (${s.lastError})` : ''}`);
      if (this._now() > deadline) { this._stop(id, 'no playlist in time'); throw new Error('The channel took too long to start'); }
      await new Promise((r) => setTimeout(r, this._pollMs));
    }
    return file;
  }

  /** A segment's file, or null (no such session, or a name that isn't one of its segments). */
  segment(channelId, name) {
    const s = this._sessions.get(String(channelId));
    if (!s || !SEGMENT.test(String(name))) return null;
    s.lastUsed = this._now();
    const file = path.join(s.dir, name);
    return fs.existsSync(file) ? file : null;
  }

  /** The channel's session ended now (the sender stopped casting it, or moved on). */
  stop(channelId, why = 'stopped') { this._stop(String(channelId), why); }

  /** Every session ended (on shutdown). */
  stopAll() {
    for (const id of [...this._sessions.keys()]) this._stop(id, 'shutdown');
    clearInterval(this._sweeper);
  }

  get size() { return this._sessions.size; }

  _start(id) {
    while (this._sessions.size >= this._maxSessions) {
      const oldest = [...this._sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
      this._stop(oldest, 'room for another channel');
    }
    const dir = path.join(this._root, id.replace(/[^\w-]/g, '_'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    log.info(TAG, `ch ${id}: casting as HLS`);
    const s = { proc: null, dir, lastUsed: this._now(), exited: false, lastError: '', restarts: [] };
    this._sessions.set(id, s);
    this._spawnFor(id, s, false);
    return s;
  }

  // FFmpeg for a session. When it ends on its own while the TV is still
  // watching — an MPEG-TS source that restarted ends its pipe — it's started
  // again into the same folder (playlist kept, a discontinuity marked); more
  // than a few times a minute and the session ends.
  _spawnFor(id, s, append) {
    const proc = this._spawn('ffmpeg', hlsArgs(this._inputUrlFor(id), s.dir, { userAgent: this._userAgent, append }), { stdio: ['ignore', 'ignore', 'pipe'] });
    s.proc = proc;
    proc.stderr?.on('data', (d) => {
      const t = String(d).trim();
      if (!t) return;
      s.lastError = t.split(/\r?\n/).pop();
      log.debug(TAG, t);
    });
    let over = false;
    const ended = (why, code) => {
      if (over) return;
      over = true;
      if (this._sessions.get(id) !== s) return;   // stopped on purpose
      const t = this._now();
      s.restarts = s.restarts.filter((at) => t - at < 60_000);
      const watched = t - s.lastUsed < this._idleMs;
      if (code === 0 && watched && s.restarts.length < this._maxRestarts) {
        s.restarts.push(t);
        log.info(TAG, `ch ${id}: the source ended — reopening it`);
        this._spawnFor(id, s, true);
        return;
      }
      s.exited = true;
      this._stop(id, why);
    };
    proc.on('error', (e) => ended(`ffmpeg failed: ${e.message}`, null));
    proc.on('close', (code) => ended(`ffmpeg exited (${code})`, code));
  }

  _stop(id, why) {
    const s = this._sessions.get(id);
    if (!s) return;
    this._sessions.delete(id);
    log.info(TAG, `ch ${id}: cast stream stopped — ${why}`);
    if (!s.exited) { try { s.proc?.kill('SIGKILL'); } catch { /* already gone */ } }
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* removed on the next start */ }
  }

  _sweep() {
    const t = this._now();
    for (const [id, s] of this._sessions) if (t - s.lastUsed > this._idleMs) this._stop(id, 'no longer watched');
  }
}

module.exports = { CastHls, hlsArgs, SEGMENT };
