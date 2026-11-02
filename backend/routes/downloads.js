// routes/downloads.js
// GET    /api/downloads         — current job list snapshot
// GET    /api/downloads/events  — SSE stream of job list updates
// POST   /api/downloads         — enqueue one or more downloads { items: [...] }
// DELETE /api/downloads/:id     — cancel a queued/in-progress job, or remove a finished one

'use strict';

const express = require('express');
const sessionMiddleware = require('../middleware/session');
const log = require('../logger');
const TAG = 'downloads';

module.exports = function downloadsModule(downloadManager, appState) {
  const router = express.Router();
  const guard = sessionMiddleware(appState);
  // The live event stream: never wakes the portal (middleware/session.js).
  const pollGuard = sessionMiddleware(appState, { wake: false });

  router.get('/', guard, (_req, res) => {
    res.json({ downloads: downloadManager.list() });
  });

  // SSE stream — pushes the full job list whenever anything changes, plus a
  // heartbeat so proxies don't drop an otherwise-idle connection. Unlike
  // /api/channels/events this has no natural "done" state (the queue is
  // long-lived), so it stays open until the client disconnects.
  router.get('/events', pollGuard, (req, res) => {
    res.set({
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    const send = (jobs) => res.write(`data: ${JSON.stringify(jobs)}\n\n`);
    send(downloadManager.list());

    const onUpdate = (jobs) => send(jobs);
    downloadManager.on('update', onUpdate);

    const hb = setInterval(() => res.write(': keepalive\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(hb);
      downloadManager.off('update', onUpdate);
    });
  });

  // POST /api/downloads  { items: [{ videoId, cmd, series, seasonId, episodeId, title, seriesTitle }] }
  // Also accepts a single item spread at the top level for convenience.
  router.post('/', guard, (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    const valid = items.filter(it => it?.videoId && it?.title);
    if (valid.length === 0) return res.status(400).json({ error: 'at least one item with videoId and title is required' });

    const jobs = downloadManager.enqueue(valid);
    log.info(TAG, `enqueued ${jobs.length} download(s)`);
    res.json({ success: true, jobs });
  });

  router.delete('/:id', guard, (req, res) => {
    const ok = downloadManager.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'download not found' });
    res.json({ success: true });
  });

  return router;
};
