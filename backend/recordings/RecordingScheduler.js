'use strict';

// Starts and stops recordings on time (recordings/Recorder.js does the
// recording), from what's booked in recordings/RecordingStore.js. Booked
// times stay as booked: a guide that moves a programme later doesn't move
// its recording.
//
// After a restart — a crash, or a planned shutdown, which leaves a running
// recording's .part as it is — a recording that was running when the server
// stopped keeps what it wrote, as "(part 1)", and the rest of it records as
// "(part 2)"; one booked for a time that has passed is marked missed.
//
// One recording going wrong (a folder that can't be made, a file that can't
// be named) fails that recording, never the scheduler: the others still start.

const fs = require('fs');
const path = require('path');
const { startRecording } = require('./Recorder');
const { readPieces, indexText } = require('./pieceIndex');
const log = require('../logger');
const TAG = 'recordings';

// What a filesystem refuses in a name (Windows' set — the strictest).
// eslint-disable-next-line no-control-regex -- control characters are refused in names too
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
// Most filesystems take 255 bytes for a name; 200 leaves room to spare. And
// recordingName leaves room in that for what's added later: " (part 1)" after
// a restart, " (N)" when the name is taken.
const MAX_NAME_BYTES = 200;
const SUFFIX_ROOM = Buffer.byteLength(' (part 1) (999)');

const bytesOf = (s) => Buffer.byteLength(s);

/** `s` cut to at most `max` bytes of UTF-8, at a character, never inside one. */
function cutBytes(s, max) {
  if (bytesOf(s) <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = bytesOf(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out.trimEnd();
}

/** "YYYY-MM-DD HH.MM" in `timeZone` (the system's when it's not one Intl knows). */
function whenOf(at, timeZone) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone }); } catch { fmt = new Intl.DateTimeFormat('en-CA', opts); }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  // "20.00", not "20:00": a colon is refused in file names on Windows and on FAT/exFAT cards.
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}.${parts.minute}`;
}

/**
 * "Channel – Programme – YYYY-MM-DD HH.MM.ts", in the server's timezone. A
 * name too long is shortened — the programme first, then the channel —
 * keeping the date and time, and a "(part N)" the programme ends with.
 */
function recordingName(rec, timeZone) {
  const safe = (s) => String(s || '').replace(UNSAFE, '_').trim();
  const tail = ` – ${whenOf(rec.startAt, timeZone)}.ts`;
  const room = MAX_NAME_BYTES - SUFFIX_ROOM - bytesOf(tail);
  const channel = safe(rec.channelName) || 'Channel';
  const title = safe(rec.title);
  if (!title) return cutBytes(channel, room) + tail;
  const SEP = ' – ';
  const [, base, suffix = ''] = /^(.*?)( \((?:part )?\d+\))?$/.exec(title);
  // The programme gets what the channel leaves — but never under 40 bytes of it while the channel can give way.
  const forTitle = Math.max(room - bytesOf(channel) - bytesOf(SEP) - bytesOf(suffix), Math.min(bytesOf(base), 40));
  const shortBase = cutBytes(base, forTitle);
  const shortChannel = cutBytes(channel, room - bytesOf(SEP) - bytesOf(shortBase) - bytesOf(suffix));
  return [shortChannel, shortBase + suffix].filter(Boolean).join(SEP) + tail;
}

/** `file`, or "name (2).ts" and on while one by that name is there — or kept for a recording running now. */
function freeName(file, reserved = new Set()) {
  const free = (f) => !reserved.has(f) && !fs.existsSync(f) && !fs.existsSync(f + '.part');
  if (free(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; ; n++) {
    const f = path.join(dir, `${name} (${n})${ext}`);
    if (free(f)) return f;
  }
}

/** The zone, when Intl knows it; else undefined (the system's), said once in the log. */
function checkedZone(timeZone) {
  if (timeZone == null) return undefined;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    log.warn(TAG, `time zone "${timeZone}" isn't one this server knows — recordings are named in the system's`);
    return undefined;
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
    this._timeZone = checkedZone(timeZone);
    this._userAgent = userAgent;
    this._running = new Map();   // id → { ac, done }
    this._reserved = new Set();  // the files of the recordings running now: no other one gets their name
    this._timer = null;
  }

  /** A look every few seconds — set first, so nothing below can stop it — then recovery after a restart. */
  async run() {
    this._timer = setInterval(() => { this.tick().catch((e) => log.error(TAG, e.message)); }, this._tickMs);
    this._timer.unref?.();
    try { this._recover(); } catch (e) { log.error(TAG, `recovery after the restart: ${e.message}`); }
    await this.tick();
  }

  _recover() {
    const now = this._now();
    for (const r of this._store.list()) {
      try {
        if (r.status === 'scheduled' && r.endAt != null && r.endAt <= now) {
          this._store.update(r.id, { status: 'missed', error: 'The server wasn\'t running at the time.' });
        } else if (r.status === 'recording' && !this._running.has(r.id)) {
          this._resume(r, now);
        }
      } catch (e) {
        log.error(TAG, `"${r.title || r.channelName}" after the restart: ${e.message}`);
      }
    }
  }

  // A recording the last run left half-made: what it wrote is part 1; the rest, part 2.
  _resume(r, now) {
    const part = r.filePath ? r.filePath + '.part' : null;
    const st = part && fs.existsSync(part) ? fs.statSync(part) : null;
    const size = st ? st.size : 0;
    const more = r.endAt == null || now < r.endAt;
    if (size > 0) {
      const file = freeName(r.filePath.replace(/\.ts$/, ' (part 1).ts'), this._reserved);
      fs.renameSync(part, file);
      // Its index goes with it: the lines that are whole and inside the file.
      if (fs.existsSync(part + '.index')) {
        fs.writeFileSync(file + '.index', indexText(readPieces(part + '.index', size)));
        fs.rmSync(part + '.index', { force: true });
      }
      // It ended when its file was last written to — its real length on the Recordings page.
      this._store.update(r.id, { status: 'done', bytes: size, filePath: file, title: `${r.title} (part 1)`,
        endedAt: Math.round(st.mtimeMs), error: 'The server restarted during this recording.' });
    } else {
      if (part) { fs.rmSync(part, { force: true }); fs.rmSync(part + '.index', { force: true }); }
      this._store.update(r.id, { status: more ? 'cancelled' : 'failed', bytes: 0, error: 'The server restarted during this recording.' });
    }
    if (more) {
      const two = this._store.schedule({ ...r, title: size > 0 ? `${r.title} (part 2)` : r.title, startAt: now, endAt: r.endAt,
        padBeforeMin: 0, padAfterMin: 0, partOf: r.id, status: 'scheduled' });
      try { this._begin(two); } catch { /* marked failed, with why */ }
    }
  }

  async tick() {
    for (const r of this._store.due(this._now())) {
      if (r.status !== 'scheduled' || this._running.has(r.id)) continue;
      try { this._begin(r); } catch { /* that one's marked failed, with why; the rest go on */ }
    }
  }

  // Starts recording `r`. When it can't (no folder, no name), `r` is marked failed and this throws why.
  _begin(r) {
    let filePath;
    try {
      const dir = this._dirFor();
      fs.mkdirSync(dir, { recursive: true });
      filePath = freeName(path.join(dir, recordingName(r, this._timeZone)), this._reserved);
    } catch (e) {
      const why = `The recording couldn't start (${e.message}).`;
      this._store.update(r.id, { status: 'failed', error: why });
      log.error(TAG, `"${r.title || r.channelName}": ${why}`);
      throw new Error(why, { cause: e });
    }
    const ac = new globalThis.AbortController();
    this._reserved.add(filePath);
    const rec = this._store.update(r.id, { status: 'recording', filePath, error: undefined });
    log.info(TAG, `recording "${r.title || r.channelName}" on ${r.channelName || r.channelId}`);
    let lastSaved = 0;
    const started = (() => {
      try {
        return this._start({
          url: this._urlFor(r.channelId), filePath, endAt: r.endAt, signal: ac.signal, now: this._now, userAgent: this._userAgent,
          // The size shown while it records: saved now and then, not on every chunk.
          onBytes: (bytes) => { if (this._now() - lastSaved > 10_000) { lastSaved = this._now(); this._store.update(r.id, { bytes }); } },
        });
      } catch (e) { return Promise.reject(e); }
    })();
    const done = started.then((res) => {
      if (res.status === 'shutdown') {
        // The server is going: still "recording", for the next start to keep as part 1.
        this._store.update(r.id, { bytes: res.bytes });
        log.info(TAG, `"${r.title || r.channelName}": left for the next start (the server is stopping)`);
        return;
      }
      // endedAt: when it really stopped (early, or when the disk filled) — its length on the Recordings page.
      this._store.update(r.id, { status: res.status, bytes: res.bytes, error: res.error, endedAt: this._now() });
      log.info(TAG, `"${r.title || r.channelName}": ${res.status}${res.error ? ` — ${res.error}` : ''}`);
    }, (e) => {
      this._store.update(r.id, { status: 'failed', error: e.message });
    }).finally(() => { this._running.delete(r.id); this._reserved.delete(filePath); });
    this._running.set(r.id, { ac, done });
    return rec;
  }

  /** Records `channelId` from now — until `endAt`, or until stopped (null). Throws why when it can't start. */
  startNow({ viewerId, channelId, channelName, title, endAt = null }) {
    const r = this._store.schedule({ viewerId, channelId, channelName, title, startAt: this._now(), endAt, source: 'manual' });
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

  /** The channels being recorded now. */
  activeChannels() {
    return this.active().map((id) => this._store.get(id)?.channelId).filter(Boolean);
  }

  /**
   * On shutdown: every recording stopped as the server going (not as done) —
   * each one's .part left as it is, so the next start keeps it as part 1 and
   * records the rest.
   */
  async stopAll() {
    clearInterval(this._timer);
    const all = [...this._running.values()];
    for (const r of all) r.ac.abort('shutdown');
    await Promise.all(all.map((r) => r.done));
  }
}

module.exports = { RecordingScheduler, recordingName };
