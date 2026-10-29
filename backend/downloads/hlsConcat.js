'use strict';

// Saves an HLS title as one .ts file by joining its pieces, no ffmpeg — the
// Solo app has none. A master playlist is followed to its highest-bandwidth
// variant. Encrypted pieces and fMP4 (an init section) can't be joined as
// plain bytes, and a variant whose sound is a separate track would save
// silent, so those are refused with a message that says so. The pieces are
// fetched one at a time, in order, and written as they come — a piece listed
// as a byte range (#EXT-X-BYTERANGE) is asked for by its range. A piece that
// fails — an error, or nothing for 30 s — is fetched again from its start, up
// to 3 tries, so one bad moment in a two-hour film doesn't lose it all; after
// that, or on an abort, it stops and the half-written file is removed.
//
// A playlist without #EXT-X-ENDLIST is still growing (an EVENT or live one):
// it's read again every target duration and each new piece, by its media
// sequence, is added in order until the end tag comes. It's given up after 6
// hours, or once it hasn't grown for 5 minutes.

const fs = require('fs');
const { request } = require('../stalker/selfStreamReader');

const MAX_DEPTH = 3; // master → media is 2; a little room, no loops

const readText = (url, o) => request(url, o, async (r) => ({ text: await r.text(), at: r.url || url }));

/** A tag's attributes (KEY=value, KEY="quoted value") as an object. */
function attrsOf(line) {
  const out = {};
  for (const m of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

/** The highest-bandwidth variant in a master playlist: { uri, audio } (its AUDIO group), or null. */
function bestVariant(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let best = null;
  let bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const a = attrsOf(lines[i]);
    const bw = Number(a.BANDWIDTH) || 0;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri && bw > bestBw) { best = { uri, audio: a.AUDIO ?? null }; bestBw = bw; }
  }
  return best;
}

/**
 * Whether a variant's sound is a separate track: the rendition of its AUDIO
 * group a player would pick (DEFAULT=YES, else the first) has a URI of its
 * own. Without one the sound is in the video's pieces.
 */
function separateAudio(text, group) {
  if (!group) return false;
  const renditions = text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('#EXT-X-MEDIA:')).map(attrsOf)
    .filter((a) => a.TYPE === 'AUDIO' && a['GROUP-ID'] === group);
  const chosen = renditions.find((a) => a.DEFAULT === 'YES') ?? renditions[0];
  return !!chosen?.URI;
}

/** Why a media playlist can't be joined as plain TS, or null. */
function refusal(text) {
  if (/^#EXT-X-MAP:/m.test(text)) return 'This title streams as fMP4 HLS, which needs FFmpeg to save.';
  for (const m of text.matchAll(/^#EXT-X-KEY:.*?METHOD=([^,\s]+)/gm)) {
    if (m[1] !== 'NONE') return `This title's HLS is encrypted (${m[1]}) and can't be saved without FFmpeg.`;
  }
  return null;
}

/**
 * A media playlist's pieces — { seq, url, range: { length, offset } | null }
 * — whether it has ended, and its target duration in seconds. A byte range
 * without an offset starts where the last range of the same URI ended.
 */
function parseMedia(text, at) {
  const pieces = [];
  let seq = 0;
  let target = 0;
  let range = null;
  const ends = new Map();   // URI → where its last range ended
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      const [n, off] = l.split(':')[1].split('@');
      range = { length: Number(n), offset: off === undefined ? null : Number(off) };
    } else if (!l.startsWith('#')) {
      const url = new URL(l, at).href;
      let r = null;
      if (range && range.length > 0) {
        const offset = range.offset ?? ends.get(url) ?? 0;
        r = { length: range.length, offset };
        ends.set(url, offset + range.length);
      }
      pieces.push({ seq: seq++, url, range: r });
      range = null;
    }
  }
  return { pieces, ended: /^#EXT-X-ENDLIST\b/m.test(text), target };
}

const TRIES = 3;                      // a piece that fails is fetched again, from its start…
const RETRY_DELAYS_MS = [1000, 3000];  // …after this long
const IDLE_MS = 30_000;                // a request that sends nothing for this long is given up
const LIVE_MAX_MS = 6 * 3600_000;      // a playlist still growing after this long is given up…
const LIVE_STALL_MS = 5 * 60_000;      // …and so is one that hasn't grown in this long

// The job was stopped: no retry, no waiting.
const stopped = (signal) => (signal.aborted ? new Error('aborted') : null);

/** Waits, or less if the job is stopped. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * @param {string} url      the playlist (master or media)
 * @param {string} outPath  where the joined bytes go (removed again if it fails)
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {(n: number) => void} [o.onBytes]  bytes just written (negative: a failed piece's, taken back)
 * @param {object} [o.headers]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.idleMs]           a piece's request that sends nothing this long is retried
 * @param {number[]} [o.retryDelaysMs]  the waits before the 2nd and 3rd try
 * @param {number} [o.pollMs]           a growing playlist's re-read interval (tests); else its target duration
 * @param {number} [o.maxMs]            a growing playlist is given up after this long
 * @param {number} [o.stallMs]          and once it hasn't grown in this long
 */
async function hlsConcat(url, outPath, { signal = new AbortController().signal, onBytes = () => {}, headers = {}, fetchImpl = globalThis.fetch,
  idleMs = IDLE_MS, retryDelaysMs = RETRY_DELAYS_MS, pollMs = null, maxMs = LIVE_MAX_MS, stallMs = LIVE_STALL_MS } = {}) {
  const o = { signal, headers, fetchImpl };
  let { text, at } = await readText(url, o);
  for (let depth = 0; text.includes('#EXT-X-STREAM-INF'); depth++) {
    const variant = bestVariant(text);
    if (!variant || depth >= MAX_DEPTH) throw new Error('a master playlist with no usable variant');
    if (separateAudio(text, variant.audio)) throw new Error("This title's sound is a separate track — it can't be saved without FFmpeg.");
    ({ text, at } = await readText(new URL(variant.uri, at).href, o));
  }
  const why = refusal(text);
  if (why) throw new Error(why);
  const mediaUrl = at;
  let list = parseMedia(text, at);
  if (!list.pieces.length && list.ended) throw new Error('the playlist lists no segments');

  // Written at explicit offsets, so a piece that fails halfway is written
  // again over the same bytes — and the file cut back to where it began.
  const file = await fs.promises.open(outPath, 'w');
  let pos = 0;
  let ok = false;
  const began = Date.now();
  let grewAt = began;
  let last = -1;   // the media sequence of the last piece written
  let n = 0;       // pieces written
  try {
    for (;;) {
      for (const piece of list.pieces) {
        if (piece.seq <= last) continue;
        n++;
        // "of N" once the playlist has ended and the count is known.
        const of = list.ended ? ` of ${n + list.pieces.filter((p) => p.seq > piece.seq).length}` : '';
        const start = pos;
        for (let attempt = 1; ; attempt++) {
          const halt = stopped(signal);
          if (halt) throw halt;
          try {
            pos = await fetchPiece(piece, o, file, start, onBytes, idleMs);
            break;
          } catch (e) {
            if (stopped(signal) || e.writeError) throw stopped(signal) || e.writeError;
            if (e.bytes) onBytes(-e.bytes);   // what it got of this piece is written again
            if (attempt >= TRIES) throw new Error(`segment ${n}${of} failed ${TRIES} times (${e.message})`, { cause: e });
            await file.truncate(start);
            await pause(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0, signal);
          }
        }
        last = piece.seq;
        grewAt = Date.now();
      }
      if (list.ended) break;
      // Still growing: read again after a target duration — within limits.
      if (Date.now() - began >= maxMs) throw new Error(`the live playlist never ended (given up after ${Math.round(maxMs / 3600_000)} hours)`);
      if (Date.now() - grewAt >= stallMs) throw new Error(`the live playlist stopped growing (nothing new in ${Math.round(stallMs / 60_000)} minutes)`);
      await pause(pollMs ?? Math.max(1, list.target || 4) * 1000, signal);
      const halt = stopped(signal);
      if (halt) throw halt;
      try {
        ({ text } = await readText(mediaUrl, o));
      } catch {
        if (stopped(signal)) throw stopped(signal);
        continue;   // a bad read: tried again next time, until it counts as not growing
      }
      const changed = refusal(text);
      if (changed) throw new Error(changed);
      list = parseMedia(text, mediaUrl);
    }
    if (!n) throw new Error('the playlist lists no segments');
    ok = true;
  } finally {
    await file.close().catch(() => {});
    if (!ok) await fs.promises.rm(outPath, { force: true }).catch(() => {});
  }
}

/**
 * One piece, written from `start`: resolves to the offset after it. Its own
 * request, given up when it sends nothing for `idleMs` (or the job stops).
 * A byte range is asked for with a Range header — and cut out of the whole
 * file when the server sends that instead (200, not 206). A failure to write
 * the file comes back as `writeError` — no use retrying.
 */
async function fetchPiece({ url, range }, o, file, start, onBytes, idleMs) {
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  o.signal.addEventListener('abort', stop);
  let idle = false;
  const timer = setTimeout(() => { idle = true; attempt.abort(); }, idleMs);
  let pos = start;
  try {
    const headers = range ? { ...o.headers, Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : o.headers;
    return await request(url, { ...o, headers, signal: attempt.signal }, async (res) => {
      // What to pass over, and how much to keep: all of it without a range.
      let skip = range && res.status !== 206 ? range.offset : 0;
      let left = range ? range.length : Infinity;
      const reader = res.body.getReader();
      const cancel = () => reader.cancel().catch(() => {});
      attempt.signal.addEventListener('abort', cancel);
      try {
        for (;;) {
          if (left <= 0) { cancel(); return pos; }
          const { done, value } = await reader.read();
          if (attempt.signal.aborted) throw new Error('aborted');
          if (done) {
            if (range) throw new Error(`the byte range ended ${left} bytes short`);
            return pos;
          }
          timer.refresh();
          let chunk = value;
          if (skip && chunk?.length) {
            const k = Math.min(skip, chunk.byteLength);
            skip -= k;
            chunk = chunk.subarray(k);
          }
          if (chunk?.length > left) chunk = chunk.subarray(0, left);
          if (chunk?.length) {
            try {
              await file.write(chunk, 0, chunk.byteLength, pos);
            } catch (e) {
              throw Object.assign(new Error(e.message, { cause: e }), { writeError: e });
            }
            pos += chunk.byteLength;
            left -= chunk.byteLength;
            onBytes(chunk.byteLength);
          }
        }
      } finally {
        attempt.signal.removeEventListener('abort', cancel);
      }
    });
  } catch (e) {
    if (idle && !o.signal.aborted) throw Object.assign(new Error(`no data for ${Math.round(idleMs / 1000)} s`), { bytes: pos - start });
    e.bytes = pos - start;
    throw e;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', stop);
  }
}

module.exports = { hlsConcat };
