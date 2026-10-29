'use strict';

// Saves an HLS title as one .ts file by joining its pieces, no ffmpeg — the
// Solo app has none. A master playlist is followed to its highest-bandwidth
// variant. Encrypted pieces and fMP4 (an init section) can't be joined as
// plain bytes, so those are refused with a message that says so. The pieces
// are fetched one at a time, in order, and written as they come. A piece that
// fails — an error, or nothing for 30 s — is fetched again from its start, up
// to 3 tries, so one bad moment in a two-hour film doesn't lose it all; after
// that, or on an abort, it stops and the half-written file is removed.

const fs = require('fs');
const { request } = require('../stalker/selfStreamReader');

const MAX_DEPTH = 3; // master → media is 2; a little room, no loops

const readText = (url, o) => request(url, o, async (r) => ({ text: await r.text(), at: r.url || url }));

/** The highest-bandwidth variant's URI in a master playlist. */
function bestVariant(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let best = null;
  let bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = Number(/BANDWIDTH=(\d+)/i.exec(lines[i])?.[1]) || 0;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri && bw > bestBw) { best = uri; bestBw = bw; }
  }
  return best;
}

/** Why a media playlist can't be joined as plain TS, or null. */
function refusal(text) {
  if (/^#EXT-X-MAP:/m.test(text)) return 'This title streams as fMP4 HLS, which needs FFmpeg to save.';
  for (const m of text.matchAll(/^#EXT-X-KEY:.*?METHOD=([^,\s]+)/gm)) {
    if (m[1] !== 'NONE') return `This title's HLS is encrypted (${m[1]}) and can't be saved without FFmpeg.`;
  }
  return null;
}

const TRIES = 3;                      // a piece that fails is fetched again, from its start…
const RETRY_DELAYS_MS = [1000, 3000];  // …after this long
const IDLE_MS = 30_000;                // a request that sends nothing for this long is given up

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
 */
async function hlsConcat(url, outPath, { signal = new AbortController().signal, onBytes = () => {}, headers = {}, fetchImpl = globalThis.fetch,
  idleMs = IDLE_MS, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const o = { signal, headers, fetchImpl };
  let { text, at } = await readText(url, o);
  for (let depth = 0; text.includes('#EXT-X-STREAM-INF'); depth++) {
    const variant = bestVariant(text);
    if (!variant || depth >= MAX_DEPTH) throw new Error('a master playlist with no usable variant');
    ({ text, at } = await readText(new URL(variant, at).href, o));
  }
  const why = refusal(text);
  if (why) throw new Error(why);
  const uris = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!uris.length) throw new Error('the playlist lists no segments');

  // Written at explicit offsets, so a piece that fails halfway is written
  // again over the same bytes — and the file cut back to where it began.
  const file = await fs.promises.open(outPath, 'w');
  let pos = 0;
  let ok = false;
  try {
    for (let i = 0; i < uris.length; i++) {
      const start = pos;
      for (let attempt = 1; ; attempt++) {
        const halt = stopped(signal);
        if (halt) throw halt;
        try {
          pos = await fetchPiece(new URL(uris[i], at).href, o, file, start, onBytes, idleMs);
          break;
        } catch (e) {
          if (stopped(signal) || e.writeError) throw stopped(signal) || e.writeError;
          if (e.bytes) onBytes(-e.bytes);   // what it got of this piece is written again
          if (attempt >= TRIES) throw new Error(`segment ${i + 1} of ${uris.length} failed ${TRIES} times (${e.message})`, { cause: e });
          await file.truncate(start);
          await pause(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0, signal);
        }
      }
    }
    ok = true;
  } finally {
    await file.close().catch(() => {});
    if (!ok) await fs.promises.rm(outPath, { force: true }).catch(() => {});
  }
}

/**
 * One piece, written from `start`: resolves to the offset after it. Its own
 * request, given up when it sends nothing for `idleMs` (or the job stops).
 * A failure to write the file comes back as `writeError` — no use retrying.
 */
async function fetchPiece(url, o, file, start, onBytes, idleMs) {
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  o.signal.addEventListener('abort', stop);
  let idle = false;
  const timer = setTimeout(() => { idle = true; attempt.abort(); }, idleMs);
  let pos = start;
  try {
    return await request(url, { ...o, signal: attempt.signal }, async (res) => {
      const reader = res.body.getReader();
      const cancel = () => reader.cancel().catch(() => {});
      attempt.signal.addEventListener('abort', cancel);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (attempt.signal.aborted) throw new Error('aborted');
          if (done) return pos;
          timer.refresh();
          if (value?.length) {
            try {
              await file.write(value, 0, value.byteLength, pos);
            } catch (e) {
              throw Object.assign(new Error(e.message, { cause: e }), { writeError: e });
            }
            pos += value.byteLength;
            onBytes(value.byteLength);
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
