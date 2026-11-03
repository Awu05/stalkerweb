'use strict';

// Live TV recordings: the ones booked, the one being made, the ones done —
// kept in recordings.json in the data folder, so a schedule outlives a
// restart. Times are milliseconds; a recording's startAt/endAt already
// include the padding asked for when it was booked (the guide's times can
// move later — what was booked stays, recordings/RecordingScheduler.js).
//
// A recording: { id, viewerId, channelId, channelName, title, startAt,
// endAt, status, source, bookedMs, filePath?, bytes, error?, partOf?, createdAt },
// status one of scheduled · recording · done · failed · missed · cancelled;
// source how it was started: 'manual' (Record now) or 'scheduled' (booked from
// the guide); bookedMs how long a booked one was booked for, with its padding
// (null: not booked) — a part 2 keeps its part 1's, though it starts later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('../lib/jsonFile');
const log = require('../logger');
const TAG = 'recordings';

const MIN = 60_000;
const MADE_AS_IT_STARTED_MS = 5_000;

/**
 * How recording `r` was started: 'manual' or 'scheduled'. One saved before
 * `source` was: Record now makes it as it starts; a booking is made ahead.
 */
function sourceOf(r) {
  if (r.source === 'manual' || r.source === 'scheduled') return r.source;
  return Math.abs(Number(r.startAt) - Number(r.createdAt)) < MADE_AS_IT_STARTED_MS ? 'manual' : 'scheduled';
}
const bookedOf = (r) => (r.source === 'scheduled' && r.endAt != null ? r.endAt - r.startAt : null);

// Saved before source and bookedMs were: filled in, a part 2 from the recording it continues.
function fillIn(list) {
  const byId = new Map(list.map((r) => [r.id, r]));
  const done = new Set();
  const fill = (r) => {
    if (done.has(r)) return;
    done.add(r);
    const from = r.partOf ? byId.get(r.partOf) : null;
    if (from) fill(from);
    if (r.source !== 'manual' && r.source !== 'scheduled') r.source = from?.source ?? sourceOf(r);
    if (r.bookedMs === undefined) r.bookedMs = from ? from.bookedMs : bookedOf(r);
  };
  list.forEach(fill);
}
// Still to be made: what clashes, and what the scheduler starts.
const PENDING = new Set(['scheduled', 'recording']);

class RecordingStore {
  constructor(dataDir, { now = Date.now } = {}) {
    this._file = path.join(dataDir, 'recordings.json');
    this._now = now;
    this._list = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      if (Array.isArray(saved)) {
        // A hand edit may leave an odd entry: kept (its file stays listed and deletable), with an id of text.
        this._list = saved.filter((r) => r && typeof r === 'object');
        for (const r of this._list) {
          if (typeof r.id === 'string' && r.id) continue;
          r.id = r.id != null && r.id !== '' ? String(r.id) : crypto.randomBytes(8).toString('hex');
          log.warn(TAG, `a recording in recordings.json had no text id — it is ${r.id} now`);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log.error(TAG, `recordings.json could not be read (${e.message}) — starting with none`);
    }
    fillIn(this._list);
  }

  // Saved on every change: recordings change a few times an hour at most.
  _save() {
    try { writeJsonAtomic(this._file, this._list); } catch (e) { log.error(TAG, `save failed: ${e.message}`); }
  }

  /** Newest first; one viewer's, or everyone's. */
  list(viewerId) {
    const mine = viewerId ? this._list.filter((r) => r.viewerId === viewerId) : this._list;
    return [...mine].sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r }));
  }

  /** The bytes every recording takes. */
  usedBytes() {
    return this._list.reduce((n, r) => n + (Number(r.bytes) || 0), 0);
  }

  get(id) {
    const r = this._list.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  /** A recording booked for a programme (its own start and end — the padding is added here). */
  schedule({ viewerId, channelId, channelName = '', title = '', startAt, endAt, padBeforeMin = 0, padAfterMin = 0, status = 'scheduled', source = 'scheduled', bookedMs, partOf }) {
    const r = {
      id: crypto.randomBytes(8).toString('hex'),
      viewerId: viewerId ?? null,
      channelId: String(channelId),
      channelName: String(channelName),
      title: String(title),
      startAt: Number(startAt) - padBeforeMin * MIN,
      endAt: endAt == null ? null : Number(endAt) + padAfterMin * MIN,   // null: until stopped
      status,
      source: source === 'manual' ? 'manual' : 'scheduled',
      bytes: 0,
      createdAt: this._now(),
      ...(partOf ? { partOf } : {}),
    };
    r.bookedMs = bookedMs !== undefined ? bookedMs : bookedOf(r);
    this._list.push(r);
    this._save();
    return { ...r };
  }

  update(id, patch) {
    const r = this._list.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, patch);
    this._save();
    return { ...r };
  }

  remove(id) {
    const before = this._list.length;
    this._list = this._list.filter((x) => x.id !== id);
    if (this._list.length === before) return false;
    this._save();
    return true;
  }

  /** What should be recording at `now`: booked, started, and not yet at its end. */
  due(now = this._now()) {
    return this._list.filter((r) => PENDING.has(r.status) && r.startAt <= now && (r.endAt == null || now < r.endAt)).map((r) => ({ ...r }));
  }

  /** When the next booked recording starts (anyone's), or null — Solo holds its server up for it (routes/solo.js). */
  nextStart(now = this._now()) {
    let next = null;
    for (const r of this._list) {
      // One whose end has passed (a tick missed) isn't coming: it mustn't hold Solo's server up for good.
      if (r.status !== 'scheduled' || (r.endAt != null && r.endAt <= now)) continue;
      if (next === null || r.startAt < next) next = r.startAt;
    }
    return next;
  }

  /** What's still to be made and overlaps [startAt, endAt). */
  overlapping(startAt, endAt) {
    return this._list.filter((r) => PENDING.has(r.status) && r.startAt < endAt && (r.endAt == null || startAt < r.endAt)).map((r) => ({ ...r }));
  }
}

module.exports = RecordingStore;
module.exports.sourceOf = sourceOf;
