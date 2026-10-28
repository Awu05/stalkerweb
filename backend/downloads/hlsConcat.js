'use strict';

// Saves an HLS title as one .ts file by joining its pieces, no ffmpeg — the
// Solo app has none. A master playlist is followed to its highest-bandwidth
// variant. Encrypted pieces and fMP4 (an init section) can't be joined as
// plain bytes, so those are refused with a message that says so. The pieces
// are fetched one at a time, in order, and written as they come; an abort
// stops it where it is (the caller deletes the half-written file).

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

/**
 * @param {string} url      the playlist (master or media)
 * @param {string} outPath  where the joined bytes go
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {(n: number) => void} [o.onBytes]  bytes just written
 * @param {object} [o.headers]
 * @param {typeof fetch} [o.fetchImpl]
 */
async function hlsConcat(url, outPath, { signal = new AbortController().signal, onBytes = () => {}, headers = {}, fetchImpl = globalThis.fetch } = {}) {
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

  const out = fs.createWriteStream(outPath);
  let failed = null;
  out.on('error', (e) => { failed = e; });
  const write = (buf) => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    out.write(buf, (e) => (e ? reject(e) : resolve()));
  });
  try {
    for (const uri of uris) {
      if (signal.aborted) throw new Error('aborted');
      await request(new URL(uri, at).href, o, async (res) => {
        const reader = res.body.getReader();
        const cancel = () => reader.cancel().catch(() => {});
        signal.addEventListener('abort', cancel);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (signal.aborted) throw new Error('aborted');
            if (done) return;
            if (value?.length) { await write(Buffer.from(value.buffer, value.byteOffset, value.byteLength)); onBytes(value.length); }
          }
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

module.exports = { hlsConcat };
