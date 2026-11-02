// routes/recordings.js — live TV recordings (recordings/)
// GET    /api/recordings           — this viewer's recordings, newest first (?all=1: everyone's it may see,
//                                     with viewerName); each row says `mine` and `canDelete` (recordings/visibility.js)
//                                     and `source` ('manual' | 'scheduled', recordings/RecordingStore.js);
//                                     `disk`: { usedBytes (every recording's), freeBytes (null: unknown) }
// POST   /api/recordings           — book a guide programme { channelId, channelName, title, startAt, endAt, force? }
// POST   /api/recordings/now       — record a channel now { channelId, channelName, title, endAt | null, force? }
// POST   /api/recordings/:id/stop  — stop one recording (what it has is kept), or cancel one not started — anyone's
//                                     (someone else's keeps `stoppedBy`: who did it)
// DELETE /api/recordings/:id       — stop it if it's running, then delete it and its file → { deleted } —
//                                     one's own, one whose viewer is gone, or — the admin — anyone's
//
// The provider's stream limit (Settings: max_streams, 1 by default): booking a
// recording that would have more running at once than that is refused (409
// with the clash). Recording now — or booking one that starts within 5
// minutes — while the limit is in use (lib/streamLimit.js: watching, casting,
// recording) asks first (409 takesStream; sent again with force, it goes ahead).

'use strict';

const express = require('express');
const fs = require('fs');
const { inUse } = require('../lib/streamLimit');
const log = require('../logger');
const { recordingRules } = require('../recordings/visibility');
const { sourceOf } = require('../recordings/RecordingStore');
const TAG = 'recordings';

const MIN = 60_000;
const SOON_MS = 5 * MIN;            // a booking starting this soon takes a stream now: asked about, like record now
const UNTIL_STOPPED_MS = 120 * MIN; // an until-stopped recording counts as running this long ahead, for the clash check

/**
 * The most of `recs` running at once inside [from, to) — and those — by a
 * sweep over their starts and ends. An until-stopped one (endAt null) runs
 * until `openEnd`.
 */
function peakRunning(recs, from, to, openEnd) {
  const events = [];
  for (const r of recs) {
    const s = Math.max(r.startAt, from);
    const e = Math.min(r.endAt ?? openEnd, to);
    if (s < e) events.push({ at: s, d: 1, r }, { at: e, d: -1, r });
  }
  // An end before a start at the same moment: one following another doesn't clash.
  events.sort((a, b) => a.at - b.at || a.d - b.d);
  const running = new Set();
  let peak = [];
  for (const ev of events) {
    if (ev.d > 0) running.add(ev.r); else running.delete(ev.r);
    if (running.size > peak.length) peak = [...running];
  }
  return peak;
}

// viewerOf(id) → the viewer, or null once deleted; channels() → the channel list (a recording's genre, for the viewer's filters);
// isAdmin(viewer) → whether it may delete anyone's; freeBytes() → the recordings disk's free space, or null.
module.exports = function recordingsModule(appState, {
  settings = () => ({}), viewerOf = () => null, channels = () => [], isAdmin = () => false, freeBytes = () => null, now = Date.now,
} = {}) {
  const router = express.Router();
  const store = () => appState.recordingStore;
  const limitOf = (s) => Math.max(1, parseInt(s.max_streams, 10) || 1);
  const pad = (s, k, dflt) => { const n = Number(s[k]); return Number.isFinite(n) && n >= 0 ? n : dflt; };
  const rulesFor = (req) => recordingRules(req.viewer, { viewerOf, channels, isAdmin });
  const streams = (n) => `${n} stream${n === 1 ? '' : 's'}`;
  // The stream limit is in use now: recording may stop what's playing.
  const takesStream = (limit) => ({
    takesStream: true,
    error: `Your provider allows ${streams(limit)} at once, and it's in use — recording may stop what's playing. Record anyway?`,
  });

  router.get('/', (req, res) => {
    const all = req.query.all === '1';
    const rules = rulesFor(req);
    // Everyone's: those of a channel this viewer's filters hide are left out (its own always show).
    const list = all ? store().list().filter(rules.visible) : store().list(req.viewer?.id ?? null);
    res.json({
      recordings: list.map((r) => ({
        ...r,
        source: sourceOf(r),
        mine: rules.mine(r),
        canDelete: rules.canDelete(r),
        ...(all ? { viewerName: rules.ownerName(r) } : {}),
      })),
      // The disk is shared: every recording counts, whichever list was asked for.
      disk: { usedBytes: store().list().reduce((n, r) => n + (Number(r.bytes) || 0), 0), freeBytes: freeBytes() ?? null },
    });
  });

  router.post('/', (req, res) => {
    const s = settings();
    const { channelId, channelName = '', title = '', force = false } = req.body ?? {};
    const startAt = Number(req.body?.startAt);
    const endAt = Number(req.body?.endAt);
    if (!channelId || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      return res.status(400).json({ error: 'A recording needs a channel and a start before its end.' });
    }
    const t = now();
    const limit = limitOf(s);
    const before = pad(s, 'record_pad_before_min', 2);
    const after = pad(s, 'record_pad_after_min', 5);
    const from = startAt - before * MIN;
    const to = endAt + after * MIN;
    if (to <= t) return res.status(400).json({ error: 'That programme has already ended.' });
    const peak = peakRunning(store().overlapping(from, to), from, to, t + UNTIL_STOPPED_MS);
    if (peak.length + 1 > limit) {
      return res.status(409).json({
        error: `This overlaps "${peak[0].title || peak[0].channelName}", and your provider allows ${streams(limit)} at once.`,
        clash: peak[0],
      });
    }
    if (!force && from <= t + SOON_MS && inUse(appState) + 1 > limit) return res.status(409).json(takesStream(limit));
    const r = store().schedule({ viewerId: req.viewer?.id ?? null, channelId, channelName, title, startAt, endAt, padBeforeMin: before, padAfterMin: after });
    log.info(TAG, `booked "${title || channelName}"`);
    res.status(201).json(r);
  });

  router.post('/now', (req, res) => {
    const s = settings();
    const { channelId, channelName = '', title = '', force = false } = req.body ?? {};
    const endAt = req.body?.endAt == null ? null : Number(req.body.endAt);
    if (!channelId || (endAt != null && !Number.isFinite(endAt))) return res.status(400).json({ error: 'A recording needs a channel.' });
    const limit = limitOf(s);
    if (!force && inUse(appState) + 1 > limit) return res.status(409).json(takesStream(limit));
    let r;
    try {
      r = appState.recordings.startNow({ viewerId: req.viewer?.id ?? null, channelId, channelName, title, endAt });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    res.status(201).json(r);
  });

  // Anyone in the household may stop or cancel one (to clear a clash, or free the stream); only its owner deletes it
  // (or anyone, once its viewer is gone).
  router.post('/:id/stop', (req, res) => {
    const r = store().get(req.params.id);
    if (!r) return res.status(404).json({ error: 'No such recording.' });
    const rules = rulesFor(req);
    const by = req.viewer?.name ?? '';
    if (appState.recordings.stop(r.id)) {
      // Someone else's: its owner sees who ("Stopped by Bea"). Kept through the recorder's own last update.
      if (!rules.mine(r) && by) store().update(r.id, { stoppedBy: by });
      const owner = rules.mine(r) ? 'their own' : `${rules.ownerName(r) || 'no one'}'s`;
      log.info(TAG, `${r.status === 'recording' ? 'stopped' : 'cancelled'} "${r.title || r.channelName}" (${owner}) — by ${by || 'the default viewer'}`);
    }
    res.json(store().get(r.id));
  });

  router.delete('/:id', async (req, res) => {
    const r = store().get(req.params.id);
    if (!r || !rulesFor(req).canDelete(r)) return res.status(404).json({ error: 'No such recording.' });
    // Stopped first, its file finished: then nothing is left half-written.
    if (appState.recordings.stop(r.id)) await appState.recordings.settled(r.id);
    const file = store().get(r.id)?.filePath;
    if (file) for (const f of [file, `${file}.index`, `${file}.part`, `${file}.part.index`]) fs.rmSync(f, { force: true });
    store().remove(r.id);
    res.json({ deleted: r.id });
  });

  return router;
};

module.exports.peakRunning = peakRunning;
