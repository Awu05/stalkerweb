// routes/channels.js
// GET /api/channels            — all channels (with optional ?group= filter)
// GET /api/channels/groups/all — all genre groups  ← must be BEFORE /:id
// GET /api/channels/:id        — single channel info
//
// Both list endpoints return immediately with whatever is currently loaded
// plus a `loading` flag so the frontend can poll/subscribe for updates.
// The actual fetch is always driven in the background — no request ever blocks
// waiting for the full channel list to arrive from the portal.

'use strict';

const express = require('express');
const router = express.Router();
const sessionMiddleware = require('../middleware/session');
const { collectLanguages } = require('../lib/languages');
const log = require('../logger');
const TAG = 'channels';

module.exports = function channelRoutes(appState) {
  const guard = sessionMiddleware(appState);
  // The event stream can't send X-Background: it never wakes the portal (middleware/session.js).
  const streamGuard = sessionMiddleware(appState, { wake: false });
  const GROUPS_WAIT_MS = 30_000;

  // GET /api/channels
  // Returns immediately with whatever channels are loaded so far.
  // Kicks off a background load if nothing is in progress and the list is empty.
  // On ?refresh=1 starts a fresh load in the background (non-blocking).
  router.get('/', guard, (req, res) => {
    const { channelManager } = appState;
    const { group, refresh } = req.query;
    const progress = channelManager.getProgress();

    if (refresh === '1') {
      if (!progress.loading) {
        log.info(TAG, 'refresh requested — starting background reload');
        channelManager.loadChannels()
          .catch(e => log.error(TAG, `refresh reload failed: ${e.message}`));
      } else {
        log.debug(TAG, 'refresh requested but load already in progress — ignoring');
      }
    } else if (channelManager.getChannels().length === 0 && !progress.loading) {
      log.info(TAG, 'no channels and not loading — starting background load');
      channelManager.loadChannels()
        .catch(e => log.error(TAG, `background load failed: ${e.message}`));
    }

    let channels = channelManager.getChannels();
    const currentProgress = channelManager.getProgress();

    if (group && group !== '*') {
      channels = channels.filter((c) => c.genreId === group);
    }

    res.json({ total: channels.length, channels, loading: currentProgress.loading });
  });

  // GET /api/channels/progress — channel load progress (poll while loading)
  router.get('/progress', guard, (req, res) => {
    const { channelManager } = appState;
    if (!channelManager) return res.json({ loading: false, page: 0, totalPages: 0, channelCount: 0 });
    res.json(channelManager.getProgress());
  });

  // GET /api/channels/languages — togglable languages for the Setup page.
  //
  // Built from channel genres AND VOD categories together, because the same
  // portal spells a language differently between the two ("BENGALI | TV" as a
  // channel genre, "BANGALI | MOVIES" as a VOD category). Offering both
  // spellings as their own entries lets the user disable each, which beats
  // maintaining a per-portal alias table that would silently rot.
  router.get('/languages', guard, async (_req, res) => {
    const { channelManager, vodManager } = appState;
    const names = channelManager.getGroups().map(g => g.name);

    // Best-effort: VOD may be disabled, or the portal may reject the call. A
    // partial language list is far better than failing the whole request.
    for (const type of ['vod', 'series']) {
      try {
        const cats = await vodManager?.getCategories(type);
        for (const c of cats || []) names.push(c.title);
      } catch (e) {
        log.debug(TAG, `languages: ${type} categories unavailable: ${e.message}`);
      }
    }

    res.json({ languages: collectLanguages(names) });
  });

  // GET /api/channels/groups/all — MUST be registered before /:id
  // Groups load early and fast: none yet, it starts the load or joins the one
  // running (loadGroups is shared) and answers once it's in — never [] while
  // one is loading — waiting at most GROUPS_WAIT_MS.
  router.get('/groups/all', guard, async (req, res) => {
    const { channelManager } = appState;
    const { refresh } = req.query;
    const progress = channelManager.getProgress();

    if (refresh === '1' && !progress.loading) {
      channelManager.loadGroups()
        .catch(e => log.error(TAG, `groups refresh failed: ${e.message}`));
    } else if (channelManager.getGroups().length === 0) {
      let timer;
      await Promise.race([
        channelManager.loadGroups().catch(e => log.error(TAG, `groups load failed: ${e.message}`)),
        new Promise((r) => { timer = setTimeout(r, GROUPS_WAIT_MS); }),
      ]);
      clearTimeout(timer);
    }

    const groups = channelManager.getGroups();
    res.json({ total: groups.length, groups });
  });

  // GET /api/channels/events — SSE stream of loading progress
  // Pushes a JSON progress object every 400ms until loading completes, then closes.
  router.get('/events', streamGuard, (req, res) => {
    const { channelManager } = appState;
    res.set({
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    // Avoid the race where a client subscribes before any load has begun and
    // immediately sees loading=false (→ "done" with 0 channels). Kick one off.
    if (channelManager.getChannels().length === 0 && !channelManager.getProgress().loading) {
      channelManager.loadChannels().catch(e => log.error(TAG, `SSE-triggered load failed: ${e.message}`));
    }

    // Pre-declared (not const) so `cleanup` can reference them even if `send()`
    // calls it on its very first, synchronous invocation below — e.g. when
    // channels are already loaded, which is true for nearly every request
    // after the initial load. With `const` declarations after that call,
    // this would throw a temporal-dead-zone ReferenceError on an already-
    // flushed SSE response.
    let iv, hb, maxLife;
    let done = false;
    const cleanup = () => { done = true; clearInterval(iv); clearInterval(hb); clearTimeout(maxLife); };

    const send = () => {
      const p = channelManager.getProgress();
      res.write(`data: ${JSON.stringify(p)}\n\n`);
      if (!p.loading) { cleanup(); res.end(); }
    };

    send(); // send immediately

    // If that first send() already finished (loading was already false —
    // the common case), skip setting up polling entirely; otherwise these
    // timers would fire res.write() on an already-ended response.
    if (!done) {
      iv = setInterval(send, 400);
      // Heartbeat comment so proxies don't buffer/drop an otherwise-idle connection.
      hb = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      // Hard cap so a stuck load can't keep a connection (and its timers) alive forever.
      maxLife = setTimeout(() => { cleanup(); res.end(); }, 5 * 60 * 1000);
    }

    req.on('close', cleanup);
  });

  // GET /api/channels/health — stream error counts per channel
  router.get('/health', guard, (req, res) => {
    const { channelManager } = appState;
    if (!channelManager) return res.json({});
    res.json(channelManager.getHealth());
  });

  // GET /api/channels/:id
  router.get('/:id', guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const ch = appState.channelManager.getChannel(id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    res.json(ch);
  });

  return router;
};
