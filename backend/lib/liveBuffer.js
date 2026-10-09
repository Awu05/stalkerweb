'use strict';

// A delay buffer for one live channel: segments are downloaded as soon as the
// source lists them, and released to players at real-time pace. The content
// held between the two is a cushion: when the source stalls (a restart that
// resends what was already played, and the smoother leaves out), players keep
// playing from it; when the source then races ahead, the burst refills it
// instead of making players jump forward.
//
// Players see a playlist of the released segments, numbered by the buffer, so
// a skipped or failed segment never leaves a hole in the numbers. It holds at
// most `seconds` (plus two target durations) beyond what was released; more
// than that is skipped, oldest first, to bound the delay and the memory.
//
// The proxy (routes/proxy.js) feeds it the source's playlists, already through
// the restart smoother, and serves segments from it.

const { parsePlaylist } = require('./restartSmoother');
const log = require('../logger');
const TAG = 'live-buffer';

const START_SEGMENTS = 3;   // released at once when a channel starts, so players can begin
const SHOWN = 6;            // released segments listed to players
const KEEP_RELEASED = 10;   // released segments whose bytes stay for players a little behind
const MAX_SEEN = 2000;

const pathOf = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } };
const headerNumber = (parsed, tag) => Number(parsed.header.find((l) => l.startsWith(`${tag}:`))?.split(':')[1]) || 0;

class LiveBuffer {
  /**
   * @param {object} opts
   * @param {number} opts.seconds            cushion to build up and hold, beyond what was released
   * @param {(url: string) => Promise<Buffer|null>} opts.download  a segment's bytes, null on failure
   */
  constructor({ seconds, download, now = Date.now, logger = log, channel = '' }) {
    this.seconds = seconds;
    this.download = download;
    this.now = now;
    this.log = logger;
    this.channel = channel;
    this.segs = [];          // in source order: { path, url, dur, dseq, bytes, at, failed, released, out, disc, rdseq }
    this.seen = new Set();   // segment paths queued
    this.target = 6;
    this.nextAt = null;      // when the next segment is due for release
    this.out = 0;            // number of the next released segment
    this.rdiscs = 0;         // discontinuities released so far
    this.gap = false;        // a segment was skipped or failed since the last release
    this.started = false;
    this.unsupported = false;
    this.dry = false;        // ran out of cushion (logged once per episode)
    this.queue = Promise.resolve();
  }

  /** A media playlist from the source (after the restart smoother): queues its new segments. */
  feed(body, playlistUrl) {
    if (/#EXT-X-(?:KEY|MAP|BYTERANGE|PART):/.test(body)) { this.unsupported = true; return; }
    const parsed = parsePlaylist(body);
    if (!parsed || !parsed.segments.length) return;
    this.target = headerNumber(parsed, '#EXT-X-TARGETDURATION') || this.target;
    let dseq = headerNumber(parsed, '#EXT-X-DISCONTINUITY-SEQUENCE');
    const fresh = [];
    for (const seg of parsed.segments) {
      if (seg.disc) dseq++;
      let url;
      try { url = new URL(seg.uri, playlistUrl).toString(); } catch { url = seg.uri; }
      const path = pathOf(url);
      if (this.seen.has(path)) continue;
      this.seen.add(path);
      fresh.push({ path, url, dur: seg.dur || this.target, dseq, bytes: null, at: null, failed: false, released: null });
    }
    if (this.seen.size > MAX_SEEN) this.seen = new Set([...this.seen].slice(-MAX_SEEN / 2));
    if (!fresh.length) return;
    if (!this.started) this._planStart(fresh);
    for (const s of fresh) {
      this.segs.push(s);
      this.queue = this.queue.then(() => this._fetch(s));
    }
    this.tick();
  }

  // When a channel starts, the source's whole window is there at once: release
  // its oldest part straight away and hold the newest `seconds` as cushion.
  _planStart(window) {
    this.started = true;
    let held = 0;
    let cut = window.length;
    while (cut > START_SEGMENTS && held + window[cut - 1].dur <= this.seconds) held += window[--cut].dur;
    for (const s of window.slice(0, Math.max(1, Math.min(cut, window.length)))) s.atStart = true;
  }

  async _fetch(s) {
    let bytes;
    try { bytes = await this.download(s.url); } catch { bytes = null; }
    s.bytes = bytes;
    s.failed = !bytes;
    s.at = this.now();
    this.tick();
  }

  /** Releases what is due; call often (the proxy does on every poll and playlist request). */
  tick() {
    const now = this.now();
    let i = this.segs.findIndex((s) => s.released === null && !s.skipped);
    while (i >= 0 && i < this.segs.length) {
      const s = this.segs[i];
      if (s.skipped) { i++; continue; }
      if (s.failed) { s.skipped = true; this.gap = true; i++; continue; }
      if (!s.bytes) break;   // still downloading: everything after it waits
      if (!s.atStart) {
        if (this.nextAt === null || now < this.nextAt) break;
      }
      this._release(s, s.atStart ? now : Math.max(this.nextAt, s.at));
      i++;
    }
    this._bound();
    this._trim();
  }

  _release(s, at) {
    const prev = this.segs.filter((x) => x.released !== null).at(-1);
    s.disc = this.gap || (prev ? s.dseq !== prev.dseq : false);
    if (s.disc) this.rdiscs++;
    s.rdseq = this.rdiscs;
    s.released = at;
    s.out = this.out++;
    this.gap = false;
    this.nextAt = at + s.dur * 1000;
    if (this.dry && this.cushion() > 0) this.dry = false;
  }

  /** Seconds of downloaded content waiting to be released. */
  cushion() {
    return this.segs.filter((s) => s.released === null && !s.skipped && s.bytes).reduce((sum, s) => sum + s.dur, 0);
  }

  // Never hold more than `seconds` plus two segments: skip the oldest held.
  _bound() {
    const limit = this.seconds + 2 * this.target;
    let held = this.cushion();
    if (held <= limit) {
      // The next segment is due but not here: the cushion ran out.
      if (this.started && !this.dry && this.nextAt !== null && this.now() > this.nextAt + 1000 && held === 0) {
        this.dry = true;
        this.log.warn(TAG, `ch ${this.channel}: buffer ran dry — the source fell more than ${this.seconds}s behind; players wait for it`);
      }
      return;
    }
    let skipped = 0;
    for (const s of this.segs) {
      if (held <= this.seconds) break;
      if (s.released !== null || s.skipped || !s.bytes) continue;
      s.skipped = true;
      s.bytes = null;
      held -= s.dur;
      skipped += s.dur;
      this.gap = true;
    }
    if (skipped) this.log.info(TAG, `ch ${this.channel}: buffer full — skipped ${skipped.toFixed(1)}s to stay within ${this.seconds}s of live`);
  }

  // Drop what players no longer need.
  _trim() {
    const released = this.segs.filter((s) => s.released !== null);
    for (const s of released.slice(0, -KEEP_RELEASED)) s.bytes = null;
    const firstKept = this.segs.indexOf(released.at(-KEEP_RELEASED) ?? released[0]);
    if (firstKept > 0) this.segs = this.segs.slice(firstKept);
  }

  /** The playlist for players (absolute source URIs), or null before anything is released. */
  playlist() {
    this.tick();
    const shown = this.segs.filter((s) => s.released !== null).slice(-SHOWN);
    if (!shown.length) return null;
    const target = Math.max(this.target, ...shown.map((s) => Math.ceil(s.dur)));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${shown[0].out}`];
    if (shown[0].rdseq) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${shown[0].rdseq}`);
    for (const [i, s] of shown.entries()) {
      if (i > 0 && s.disc) lines.push('#EXT-X-DISCONTINUITY');   // the first one's is in the header
      lines.push(`#EXTINF:${s.dur.toFixed(3)},`, s.url);
    }
    return lines.join('\n') + '\n';
  }

  /** A held segment's bytes, by its source URL, or null. */
  bytesFor(url) {
    const path = pathOf(url);
    return this.segs.find((s) => s.path === path && s.bytes)?.bytes ?? null;
  }

  /** Resolves once players have something to play (or after `ms`). */
  async ready(ms) {
    const until = Date.now() + ms;
    while (!this.playlist() && Date.now() < until && !this.unsupported) await new Promise((r) => setTimeout(r, 100));
    return !!this.playlist();
  }
}

module.exports = { LiveBuffer };
