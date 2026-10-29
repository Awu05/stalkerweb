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
// 3 listed — as players do. An HLS channel whose segments aren't plain TS
// (encrypted, or fMP4) isn't read at all: onUnsupported() says why, and the
// TV is sent to the channel's own HLS instead (CastHls.js).
//
// When the source ends, fails, or sends nothing for a while, onBreak() says so
// (the segmenter marks a discontinuity) and it's opened again after
// min(2^n × 250 ms, 5 s), n the breaks since bytes last came. onBreak() comes
// once per gap: not again until bytes have flowed, however many tries the
// outage takes. An HLS channel carries on from the segment after the last one
// sent, when the playlist still lists it, so the TV isn't shown again what it
// played — numbered by #EXT-X-MEDIA-SEQUENCE, or by the segments' URIs when a
// playlist has none. A segment that breaks off midway is fetched again whole,
// after the break: the segmenter starts a new piece at its keyframe. Skipping
// the bytes already sent instead would bet on the second copy matching the
// first byte for byte, and a mismatch is a broken picture. It ends when `signal`
// aborts — or gives up on a channel that stopped answering: 8 tries in a row
// with nothing, or 2 minutes without a byte. Then it rejects (`gaveUp`), and
// the cast session ends rather than knock at the portal for as long as the
// TV keeps asking.

const { parsePlaylist } = require('../lib/restartSmoother');

const START_SEGMENTS = 3;      // where an HLS channel starts: this many from the end
const STALL_MS = 15_000;       // nothing in this long: the source is gone, open it again
const GIVE_UP_TRIES = 8;       // tries in a row with nothing: the channel stopped answering
const GIVE_UP_MS = 120_000;    // and so has one that sent nothing in this long
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
 * @param {(why: string) => void} [o.onUnsupported]  an HLS channel whose segments aren't plain TS
 *   (encrypted, or fMP4): nothing is read, and the promise resolves
 * @param {AbortSignal} o.signal             stops it (the promise then resolves)
 * @param {string} [o.userAgent]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.pollMs]                the HLS playlist's re-read interval (tests); else half a segment
 * @param {(n: number) => number} [o.backoffMs]  the wait before try n+1 after n in a row with nothing (tests)
 * @param {() => number} [o.now]             the clock, for the 2 minutes (tests)
 */
async function readSelfStream(url, { onData, onBreak, onUnsupported = () => {}, signal, userAgent = null, fetchImpl = globalThis.fetch,
  pollMs = null, stallMs = STALL_MS, backoffMs = backoff, now = Date.now } = {}) {
  const headers = userAgent ? { 'User-Agent': userAgent } : {};
  // Across reconnects: where an HLS channel got to (the restart smoother keeps
  // its numbers steady), and a segment that failed once already.
  const state = { last: null, failed: null, uris: null };
  let breaks = 0;
  let lastData = now();
  // One onBreak per gap: none again until a byte has come.
  let quiet = false;
  const brk = () => { if (!quiet) { quiet = true; onBreak(); } };
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
    let unsupported = null;
    const o = {
      headers, fetchImpl, pollMs, onBreak: brk, state, signal: attempt.signal,
      data: (buf) => { got = true; quiet = false; alive(); onData(buf); },
    };
    try {
      alive();
      await readOnce(url, o);
    } catch (e) {
      unsupported = e.unsupported ?? null;   // else failed: handled as an end
    }
    clearTimeout(stall);
    signal.removeEventListener('abort', stop);
    if (signal.aborted) break;
    if (unsupported) { onUnsupported(unsupported); return; }
    if (got) { breaks = 0; lastData = now(); }
    else if (breaks + 1 >= GIVE_UP_TRIES || now() - lastData >= GIVE_UP_MS) {
      throw Object.assign(new Error('the channel stopped answering'), { gaveUp: true });
    }
    brk();
    await sleep(backoffMs(breaks++), signal);
  }
}

/**
 * One request, with its own abort linked to the attempt's — fetch adds a
 * listener to the signal it's given and frees it only on GC, so one signal
 * for every request piled them up. `use` reads the response.
 */
async function request(url, o, use) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  o.signal.addEventListener('abort', abort);
  if (o.signal.aborted) ctrl.abort();
  try {
    const res = await o.fetchImpl(url, { headers: o.headers, signal: ctrl.signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    return await use(res);
  } finally {
    o.signal.removeEventListener('abort', abort);
  }
}

const readText = (url, o) => request(url, o, async (r) => ({ text: await r.text(), at: r.url || url }));

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

/**
 * Why a media playlist's segments aren't plain MPEG-TS the segmenter can cut,
 * or null: encrypted (AES-128, SAMPLE-AES) or fMP4 (an init section). The
 * proxy passes these through as they are; the TV plays them itself.
 */
function unsupportedWhy(text) {
  if (/^#EXT-X-MAP:/m.test(text)) return 'fMP4 segments (EXT-X-MAP)';
  for (const m of text.matchAll(/^#EXT-X-KEY:.*?METHOD=([^,\s]+)/gm)) {
    if (m[1] !== 'NONE') return `encrypted segments (${m[1]})`;
  }
  return null;
}

// /proxy/stream once: a raw stream until it ends, or an HLS channel followed until it does.
async function readOnce(url, o) {
  const got = await request(url, o, async (res) => {
    if (/mpegurl/i.test(res.headers.get('content-type') || '')) return { text: await res.text(), at: res.url || url };
    // No playlist type: a raw stream, unless its first bytes say otherwise.
    // Enough of it to tell: a first chunk of a few bytes may yet be "#EXTM3U".
    const reader = res.body.getReader();
    const head = () => first.subarray(0, 16).toString('latin1').trimStart();
    let first = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      first = Buffer.concat([first, Buffer.from(value)]);
      const h = head();
      if (first.length >= 16 || h.length >= 7 || !'#EXTM3U'.startsWith(h)) break;
    }
    if (!first.length) return null;
    if (!head().startsWith('#EXTM3U')) {
      reader.releaseLock();
      await pipeBody(res, o, first);
      return null;
    }
    return { text: await restAsText(reader, first), at: res.url || url };
  });
  if (!got) return;
  let { text, at } = got;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const variant = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!variant) throw new Error('a master playlist with no variant');
    ({ text, at } = await readText(new URL(variant, at).href, o));
  }
  return followPlaylist(at, text, o);
}

/**
 * A media playlist with no #EXT-X-MEDIA-SEQUENCE, numbered by its URIs: a
 * segment the last read listed keeps its number, the rest follow on from it.
 * Nothing in common with the last read means the playlist moved on past it.
 */
function numberByUri(text, st) {
  const list = parsePlaylist(text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0'));
  if (!list) return null;
  let base = null;
  for (let i = 0; i < list.segments.length && st.uris; i++) {
    const seq = st.uris.get(list.segments[i].uri);
    if (seq !== undefined) { base = seq - i; break; }
  }
  if (base === null) base = st.last === null ? 0 : st.last + 2;   // after a gap
  list.segments.forEach((seg, i) => { seg.seq = base + i; });
  st.uris = new Map(list.segments.map((seg) => [seg.uri, seg.seq]));
  return list;
}

// A live media playlist: each new segment once, in order, until it ends. Goes
// on from where the last attempt got to when the playlist still lists it.
async function followPlaylist(at, text, o) {
  const st = o.state;
  for (let first = true; ; first = false) {
    const why = unsupportedWhy(text);
    if (why) throw Object.assign(new Error(why), { unsupported: why });
    const list = /^#EXT-X-MEDIA-SEQUENCE:/m.test(text) ? parsePlaylist(text) : numberByUri(text, st);
    if (!list) throw new Error('not a media playlist');
    const segs = list.segments;
    if (st.last !== null && segs.length && segs.at(-1).seq < st.last) {
      if (!first) throw new Error('the playlist went back');   // the source restarted: open it again
      st.last = null;                                          // and start over at its live edge
      o.onBreak();
    }
    let fresh;
    if (st.last === null) fresh = segs.slice(-START_SEGMENTS);
    // Moved on past where we were (a long reconnect): from the live edge, after a gap.
    else if (first && segs.length && segs[0].seq > st.last + 1) fresh = segs.slice(-START_SEGMENTS);
    else fresh = segs.filter((s) => s.seq > st.last);
    for (const s of fresh) {
      // A gap or a discontinuity at the source: a break inside the stream.
      if (st.last !== null && (s.disc || s.seq !== st.last + 1)) o.onBreak();
      try {
        await request(new URL(s.uri, at).href, o, (r) => pipeBody(r, o));
        if (st.failed === s.seq && !o.signal.aborted) st.failed = null;   // it came through after all
      } catch (e) {
        if (o.signal.aborted) return;
        // Tried again once, after a reconnect; failed twice, it's skipped.
        if (st.failed !== s.seq) { st.failed = s.seq; throw e; }
        o.onBreak();
      }
      if (o.signal.aborted) return;
      st.last = s.seq;
    }
    if (list.trailer.includes('#EXT-X-ENDLIST')) return;
    const target = Number(list.header.find((l) => l.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1]) || 4;
    await sleep(o.pollMs ?? Math.min(5000, Math.max(500, target * 500)), o.signal);
    if (o.signal.aborted) return;
    ({ text } = await readText(at, o));
  }
}

module.exports = { readSelfStream, request };
