'use strict';

// This server reading a channel from its own /proxy/stream/<id>, for the cast
// packager (CastHls.js) — what FFmpeg's input did. /proxy/stream answers with
// the channel as the portal sends it: raw MPEG-TS, or an HLS playlist (already
// through the live buffer and the restart smoother). Either way the segmenter
// wants one stream of TS bytes.
//
// Raw TS: the body is passed on as it comes. HLS: the playlist is read again
// about twice a segment, and each new segment is fetched once, in order (for a
// master playlist, its first variant). It starts at the live edge — the last
// 3 listed — as players do.
//
// When the source ends, fails, or sends nothing for a while, onBreak() says so
// (the segmenter marks a discontinuity) and it's opened again after
// min(2^n × 250 ms, 5 s), n the breaks since bytes last came. It only ends
// when `signal` aborts.

const { parsePlaylist } = require('../lib/restartSmoother');

const START_SEGMENTS = 3;      // where an HLS channel starts: this many from the end
const STALL_MS = 15_000;       // nothing in this long: the source is gone, open it again
const backoff = (n) => Math.min(2 ** n * 250, 5000);

/** Waits `ms`, or less when `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * @param {string} url  this server's /proxy/stream URL for the channel
 * @param {object} o
 * @param {(buf: Buffer) => void} o.onData   the channel's TS bytes
 * @param {() => void} o.onBreak             the source broke off; what comes next is after a gap
 * @param {AbortSignal} o.signal             stops it (the promise then resolves)
 * @param {string} [o.userAgent]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.pollMs]                the HLS playlist's re-read interval (tests); else half a segment
 */
async function readSelfStream(url, { onData, onBreak, signal, userAgent = null, fetchImpl = globalThis.fetch, pollMs = null, stallMs = STALL_MS } = {}) {
  const headers = userAgent ? { 'User-Agent': userAgent } : {};
  let breaks = 0;
  while (!signal.aborted) {
    // One go at the source, with its own abort: for the caller's, and for a stall.
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    signal.addEventListener('abort', stop);
    let stall = null;
    const alive = () => {
      clearTimeout(stall);
      stall = setTimeout(stop, stallMs);
      stall.unref?.();
    };
    let got = false;
    const o = {
      headers, fetchImpl, pollMs, onBreak, signal: attempt.signal,
      data: (buf) => { got = true; alive(); onData(buf); },
    };
    try {
      alive();
      await readOnce(url, o);
    } catch { /* failed: handled as an end */ }
    clearTimeout(stall);
    signal.removeEventListener('abort', stop);
    if (signal.aborted) break;
    if (got) breaks = 0;
    onBreak();
    await sleep(backoff(breaks++), signal);
  }
}

async function get(url, o) {
  const res = await o.fetchImpl(url, { headers: o.headers, signal: o.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** Passes a body on as it comes; resolves when it ends (or the attempt is aborted). */
async function pipeBody(res, o, first = null) {
  const reader = res.body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  o.signal.addEventListener('abort', cancel);
  try {
    if (first) o.data(first);
    for (;;) {
      const { done, value } = await reader.read();
      if (done || o.signal.aborted) return;
      if (value?.length) o.data(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    o.signal.removeEventListener('abort', cancel);
  }
}

/** The rest of a body as text, after the bytes already read. */
async function restAsText(reader, first) {
  const parts = [first];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts).toString('utf8');
    parts.push(Buffer.from(value));
  }
}

// /proxy/stream once: a raw stream until it ends, or an HLS channel followed until it does.
async function readOnce(url, o) {
  const res = await get(url, o);
  let text;
  if (/mpegurl/i.test(res.headers.get('content-type') || '')) text = await res.text();
  else {
    // No playlist type: a raw stream, unless its first bytes say otherwise.
    const reader = res.body.getReader();
    const { done, value } = await reader.read();
    if (done) return;
    const first = Buffer.from(value);
    if (!first.subarray(0, 16).toString('latin1').trimStart().startsWith('#EXTM3U')) {
      reader.releaseLock();
      return pipeBody(res, o, first);
    }
    text = await restAsText(reader, first);
  }
  let at = res.url || url;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const variant = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!variant) throw new Error('a master playlist with no variant');
    at = new URL(variant, at).href;
    const r = await get(at, o);
    at = r.url || at;
    text = await r.text();
  }
  return followPlaylist(at, text, o);
}

// A live media playlist: each new segment once, in order, until it ends.
async function followPlaylist(at, text, o) {
  let last = null;   // the sequence number of the last segment passed on
  for (;;) {
    const list = parsePlaylist(text.includes('#EXT-X-MEDIA-SEQUENCE:') ? text : text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0'));
    if (!list) throw new Error('not a media playlist');
    const segs = list.segments;
    if (last !== null && segs.length && segs.at(-1).seq < last) throw new Error('the playlist went back');   // the source restarted
    const fresh = last === null ? segs.slice(-START_SEGMENTS) : segs.filter((s) => s.seq > last);
    for (const s of fresh) {
      // A gap (we fell behind) or a discontinuity at the source: a break inside the stream.
      if (last !== null && (s.disc || s.seq !== last + 1)) o.onBreak();
      await pipeBody(await get(new URL(s.uri, at).href, o), o);
      if (o.signal.aborted) return;
      last = s.seq;
    }
    if (list.trailer.includes('#EXT-X-ENDLIST')) return;
    const target = Number(list.header.find((l) => l.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1]) || 4;
    await sleep(o.pollMs ?? Math.min(5000, Math.max(500, target * 500)), o.signal);
    if (o.signal.aborted) return;
    const r = await get(at, o);
    text = await r.text();
  }
}

module.exports = { readSelfStream };
