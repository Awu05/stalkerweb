// routes/recordings.js — live TV recordings (recordings/)
// GET    /api/recordings           — this viewer's recordings, newest first (?all=1: everyone's, with viewerName)
// POST   /api/recordings           — book a guide programme { channelId, channelName, title, startAt, endAt }
// POST   /api/recordings/now       — record a channel now { channelId, channelName, title, endAt | null, force? }
// POST   /api/recordings/:id/stop  — stop one recording (what it has is kept), or cancel one not started
// DELETE /api/recordings/:id       — stop it if it's running, then delete it and its file → { deleted }
//
// The provider's stream limit (Settings: max_streams, 1 by default): booking a
// recording that would overlap others past it is refused (409 with the
// clash); recording now while the limit is in use asks first (409
// takesStream; sent again with force, it starts).

'use strict';

const express = require('express');
const fs = require('fs');
const log = require('../logger');
const TAG = 'recordings';

module.exports = function recordingsModule(appState, { settings = () => ({}), viewerName = () => '' } = {}) {
  const router = express.Router();
  const store = () => appState.recordingStore;
  const limitOf = () => Math.max(1, parseInt(settings().max_streams, 10) || 1);
  const pad = (k, dflt) => { const n = Number(settings()[k]); return Number.isFinite(n) && n >= 0 ? n : dflt; };
  const mine = (req, r) => r && r.viewerId === (req.viewer?.id ?? null);
  const streams = (n) => `${n} stream${n === 1 ? '' : 's'}`;

  router.get('/', (req, res) => {
    const all = req.query.all === '1';
    const list = store().list(all ? undefined : req.viewer?.id ?? null);
    res.json({ recordings: all ? list.map((r) => ({ ...r, viewerName: viewerName(r.viewerId) })) : list });
  });

  router.post('/', (req, res) => {
    const { channelId, channelName = '', title = '' } = req.body ?? {};
    const startAt = Number(req.body?.startAt);
    const endAt = Number(req.body?.endAt);
    if (!channelId || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      return res.status(400).json({ error: 'A recording needs a channel and a start before its end.' });
    }
    const before = pad('record_pad_before_min', 2);
    const after = pad('record_pad_after_min', 5);
    const from = startAt - before * 60_000;
    const to = endAt + after * 60_000;
    const clashes = store().overlapping(from, to);
    if (clashes.length + 1 > limitOf()) {
      return res.status(409).json({
        error: `This overlaps "${clashes[0].title || clashes[0].channelName}", and your provider allows ${streams(limitOf())} at once.`,
        clash: clashes[0],
      });
    }
    const r = store().schedule({ viewerId: req.viewer?.id ?? null, channelId, channelName, title, startAt, endAt, padBeforeMin: before, padAfterMin: after });
    log.info(TAG, `booked "${title || channelName}"`);
    res.status(201).json(r);
  });

  router.post('/now', (req, res) => {
    const { channelId, channelName = '', title = '', force = false } = req.body ?? {};
    const endAt = req.body?.endAt == null ? null : Number(req.body.endAt);
    if (!channelId || (endAt != null && !Number.isFinite(endAt))) return res.status(400).json({ error: 'A recording needs a channel.' });
    // The portal streams open now — watching, casting and recordings alike all go through /proxy/stream.
    const inUse = appState.activeStreams || 0;
    if (!force && inUse + 1 > limitOf()) {
      return res.status(409).json({
        takesStream: true,
        error: `You're already watching, and your provider allows ${streams(limitOf())} at once — recording may stop what's playing. Record anyway?`,
      });
    }
    const r = appState.recordings.startNow({ viewerId: req.viewer?.id ?? null, channelId, channelName, title, endAt });
    res.status(201).json(r);
  });

  router.post('/:id/stop', (req, res) => {
    const r = store().get(req.params.id);
    if (!mine(req, r)) return res.status(404).json({ error: 'No such recording.' });
    appState.recordings.stop(r.id);
    res.json(store().get(r.id));
  });

  router.delete('/:id', async (req, res) => {
    const r = store().get(req.params.id);
    if (!mine(req, r)) return res.status(404).json({ error: 'No such recording.' });
    // Stopped first, its file finished: then nothing is left half-written.
    if (appState.recordings.stop(r.id)) await appState.recordings.settled(r.id);
    const file = store().get(r.id)?.filePath;
    if (file) for (const f of [file, `${file}.index`, `${file}.part`, `${file}.part.index`]) fs.rmSync(f, { force: true });
    store().remove(r.id);
    res.json({ deleted: r.id });
  });

  return router;
};
