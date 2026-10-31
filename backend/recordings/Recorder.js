'use strict';

// One recording: a live channel written to a .ts file as it arrives, no
// re-encoding. It reads this server's own /proxy/stream for the channel
// (stalker/selfStreamReader.js), so it gets the live buffer and the restart
// smoother — the provider's restarts and 4K stutter are handled before the
// bytes get here. A gap in the source is a gap in the file, not the end of
// the recording: the reader is opened again when it gives up, until the end
// time. Written to <file>.part and renamed when it's over.
//
// The result: done (with what was recorded — also when stopped early, or
// when the disk filled up: `error` says so), or failed (nothing recorded:
// too little space to start, a channel that never sent anything, one that
// can't be recorded).

const fs = require('fs');
const { readSelfStream } = require('../stalker/selfStreamReader');

const GB = 1024 ** 3;
const MIN_FREE_TO_START = GB;          // the spec: at least 1 GB free to start
const MIN_FREE_WHILE = 50 * 1024 ** 2; // below this while recording: the disk is full

/** Free bytes on the disk holding `dir` (null when it can't be told). */
function freeBytesOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch { return null; }
}

/**
 * @param {object} o
 * @param {string} o.url         this server's /proxy/stream URL for the channel
 * @param {string} o.filePath    where the finished recording goes
 * @param {number|null} o.endAt  when to stop (ms); null: until stopped
 * @param {AbortSignal} [o.signal]  stops it early — what was recorded is kept
 * @param {(bytes: number) => void} [o.onBytes]  the size so far, as it grows
 * @param {() => number|null} [o.freeBytes]      free disk space (tests)
 * @returns {Promise<{ status: 'done'|'failed', bytes: number, error?: string }>}
 */
async function startRecording({
  url, filePath, endAt = null, signal = new globalThis.AbortController().signal, now = Date.now, onBytes = () => {},
  freeBytes = () => freeBytesOf(require('path').dirname(filePath)), reader = readSelfStream, userAgent = null,
  checkEveryMs = 1000, retryMs = 5000,
}) {
  const free = freeBytes();
  if (free != null && free < MIN_FREE_TO_START) {
    return { status: 'failed', bytes: 0, error: 'Less than 1 GB free on the disk — the recording didn\'t start.' };
  }

  const part = filePath + '.part';
  const out = fs.createWriteStream(part);
  let bytes = 0;
  let error = null;
  let unsupported = null;
  let writeFailed = null;
  out.on('error', (e) => { writeFailed = e; stop(); });

  // One abort for everything: the caller's, the end time, a full disk.
  const ac = new globalThis.AbortController();
  const stop = () => ac.abort();
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  const check = setInterval(() => {
    if (endAt != null && now() >= endAt) stop();
    const f = freeBytes();
    if (f != null && f < MIN_FREE_WHILE) { error = 'The disk filled up — the recording stopped with what it had.'; stop(); }
  }, checkEveryMs);

  const onData = (buf) => {
    if (ac.signal.aborted) return;
    bytes += buf.length;
    out.write(buf);
    onBytes(bytes);
  };

  while (!ac.signal.aborted) {
    try {
      await reader(url, {
        onData, onBreak: () => {}, signal: ac.signal, userAgent,
        onUnsupported: (why) => { unsupported = why; stop(); },
      });
    } catch (e) {
      if (!e?.gaveUp) { error = e?.message || 'The recording stopped.'; break; }
      // The channel stopped answering for a while: a gap, then try again — until the end.
    }
    if (ac.signal.aborted) break;
    await new Promise((r) => { const t = setTimeout(r, retryMs); ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  }
  clearInterval(check);
  signal.removeEventListener('abort', stop);

  await new Promise((r) => out.end(r));
  if (writeFailed?.code === 'ENOSPC') error = 'The disk filled up — the recording stopped with what it had.';
  else if (writeFailed) error = `The recording couldn't be written (${writeFailed.code || writeFailed.message}).`;

  if (bytes === 0) {
    fs.rmSync(part, { force: true });
    const why = unsupported ? `This channel can't be recorded (${unsupported}).`
      : error || 'The channel stopped sending before anything was recorded.';
    return { status: 'failed', bytes: 0, error: why };
  }
  fs.renameSync(part, filePath);
  return { status: 'done', bytes, ...(error ? { error } : {}) };
}

module.exports = { startRecording, freeBytesOf };
