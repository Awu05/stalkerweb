'use strict';

// Starts and stops recordings on time (recordings/Recorder.js does the
// recording), from what's booked in recordings/RecordingStore.js. Booked
// times stay as booked: a guide that moves a programme later doesn't move
// its recording.
//
// After a restart: a recording that was running when the server stopped
// keeps what it wrote, as "(part 1)", and the rest of it records as
// "(part 2)"; one booked for a time that has passed is marked missed.

const fs = require('fs');
const path = require('path');
const { startRecording } = require('./Recorder');
const log = require('../logger');
const TAG = 'recordings';

// What a filesystem refuses in a name (Windows' set — the strictest).
// eslint-disable-next-line no-control-regex -- control characters are refused in names too
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

/** "Channel – Programme – YYYY-MM-DD HH.MM.ts", in the server's timezone. */
function recordingName(rec, timeZone) {
  const at = new Date(rec.startAt);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  // "20.00", not "20:00": a colon is refused in file names on Windows and on FAT/exFAT cards.
  const when = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}.${parts.minute}`;
  const safe = (s) => String(s || '').replace(UNSAFE, '_').trim();
  return [safe(rec.channelName) || 'Channel', safe(rec.title), when].filter(Boolean).join(' – ') + '.ts';
}

/** `file`, or "name (2).ts" and on while one by that name is there. */
function freeName(file) {
  if (!fs.existsSync(file) && !fs.existsSync(file + '.part')) return file;
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; ; n++) {
    const f = path.join(dir, `${name} (${n})${ext}`);
    if (!fs.existsSync(f) && !fs.existsSync(f + '.part')) return f;
  }
}

class RecordingScheduler {
  /**
   * @param {object} o
   * @param {import('./RecordingStore')} o.store
   * @param {(channelId: string) => string} o.urlFor  this server's /proxy/stream URL for a channel
   * @param {() => string} o.dirFor                    the recordings folder (made if missing)
   * @param {string} [o.timeZone]                       for the names
   */
  constructor({ store, urlFor, dirFor, start = startRecording, now = Date.now, tickMs = 5000, timeZone, userAgent = null }) {
    this._store = store;
    this._urlFor = urlFor;
    this._dirFor = dirFor;
    this._start = start;
    this._now = now;
    this._tickMs = tickMs;
    this._timeZone = timeZone;
    this._userAgent = userAgent;
    this._running = new Map();   // id → { ac, done }
    this._timer = null;
  }

  /** Recovery after a restart, then a look every few seconds. */
  async run() {
    this._recover();
    await this.tick();
    this._timer = setInterval(() => { this.tick().catch((e) => log.error(TAG, e.message)); }, this._tickMs);
    this._timer.unref?.();
  }

  _recover() {
    const now = this._now();
    for (const r of this._store.list()) {
      if (r.status === 'scheduled' && r.endAt != null && r.endAt <= now) {
        this._store.update(r.id, { status: 'missed', error: 'The server wasn\'t running at the time.' });
      } else if (r.status === 'recording' && !this._running.has(r.id)) {
        this._resume(r, now);
      }
    }
  }

  // A recording the last run left half-made: what it wrote is part 1; the rest, part 2.
  _resume(r, now) {
    const part = r.filePath ? r.filePath + '.part' : null;
    const size = part && fs.existsSync(part) ? fs.statSync(part).size : 0;
    const more = r.endAt == null || now < r.endAt;
    if (size > 0) {
      const file = freeName(r.filePath.replace(/\.ts$/, ' (part 1).ts'));
      fs.renameSync(part, file);
      this._store.update(r.id, { status: 'done', bytes: size, filePath: file, title: `${r.title} (part 1)`,
        error: 'The server restarted during this recording.' });
    } else {
      if (part) fs.rmSync(part, { force: true });
      this._store.update(r.id, { status: more ? 'cancelled' : 'failed', bytes: 0, error: 'The server restarted during this recording.' });
    }
    if (more) {
      const two = this._store.schedule({ ...r, title: size > 0 ? `${r.title} (part 2)` : r.title, startAt: now, endAt: r.endAt,
        padBeforeMin: 0, padAfterMin: 0, partOf: r.id, status: 'scheduled' });
      this._begin(two);
    }
  }

  async tick() {
    for (const r of this._store.due(this._now())) {
      if (r.status === 'scheduled' && !this._running.has(r.id)) this._begin(r);
    }
  }

  _begin(r) {
    const dir = this._dirFor();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = freeName(path.join(dir, recordingName(r, this._timeZone)));
    const ac = new globalThis.AbortController();
    const rec = this._store.update(r.id, { status: 'recording', filePath, error: undefined });
    log.info(TAG, `recording "${r.title || r.channelName}" on ${r.channelName || r.channelId}`);
    let lastSaved = 0;
    const done = this._start({
      url: this._urlFor(r.channelId), filePath, endAt: r.endAt, signal: ac.signal, now: this._now, userAgent: this._userAgent,
      // The size shown while it records: saved now and then, not on every chunk.
      onBytes: (bytes) => { if (this._now() - lastSaved > 10_000) { lastSaved = this._now(); this._store.update(r.id, { bytes }); } },
    }).then((res) => {
      this._store.update(r.id, { status: res.status, bytes: res.bytes, error: res.error });
      log.info(TAG, `"${r.title || r.channelName}": ${res.status}${res.error ? ` — ${res.error}` : ''}`);
    }, (e) => {
      this._store.update(r.id, { status: 'failed', error: e.message });
    }).finally(() => this._running.delete(r.id));
    this._running.set(r.id, { ac, done });
    return rec;
  }

  /** Records `channelId` from now — until `endAt`, or until stopped (null). */
  startNow({ viewerId, channelId, channelName, title, endAt = null }) {
    const r = this._store.schedule({ viewerId, channelId, channelName, title, startAt: this._now(), endAt });
    return this._begin(r);
  }

  /** Stops one recording (what it has is kept) or cancels one not yet started. */
  stop(id) {
    const running = this._running.get(id);
    if (running) { running.ac.abort(); return true; }
    const r = this._store.get(id);
    if (!r || r.status !== 'scheduled') return false;
    this._store.update(id, { status: 'cancelled' });
    return true;
  }

  /** Waits for a running recording to finish (after stop) — before deleting it. */
  async settled(id) { await this._running.get(id)?.done; }

  active() { return [...this._running.keys()]; }

  /** On shutdown: every recording stopped, its file finished. */
  async stopAll() {
    clearInterval(this._timer);
    const all = [...this._running.values()];
    for (const r of all) r.ac.abort();
    await Promise.all(all.map((r) => r.done));
  }
}

module.exports = { RecordingScheduler, recordingName };
