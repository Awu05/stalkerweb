// routes/vod.js
// GET    /api/vod/categories?type=vod|series
// GET    /api/vod/items?type=vod|series&category=X&page=1&search=&fav=0
// GET    /api/vod/seasons/:movieId
// GET    /api/vod/stream?videoId=X&cmd=<encoded>&series=0
// GET    /api/vod/listing?type&category&from — a whole category, as it is read
// GET/PUT/DELETE /api/vod/watch…  — what the viewer watched (see below)

'use strict';

const express = require('express');
const router  = express.Router();
const sessionMiddleware = require('../middleware/session');
const { visibleVodCategories } = require('../lib/vodCategoryFilter');
const { vodLayout } = require('../lib/seriesCategories');
const { refuseIfGone } = require('./viewers');

// The Series "All" added on portals without a series section (see below).
const SERIES_ALL = 'series:all';

const log = require('../logger');
const TAG = 'vod';

module.exports = function vodRoutes(appState, config, { watchStore = null } = {}) {
  const guard = sessionMiddleware(appState);

  // GET /api/vod/categories?type=vod|series[&all=1]
  //
  // Movies or Series. On a portal with no series section, the movie categories
  // named for shows are its Series (lib/seriesCategories.js). Filtered by the
  // current viewer's hidden movie & series categories (and an old
  // hidden-languages list), dropping the portal's "All" pseudo-category
  // whenever anything is hidden (lib/vodCategoryFilter.js). Done here rather
  // than in each client, so every client gets the same answer. ?all=1 lists
  // the portal's own categories as they are, for the Settings list.
  router.get('/categories', guard, async (req, res) => {
    const { vodManager } = appState;
    const type = req.query.type === 'series' ? 'series' : 'vod';
    if (req.query.all === '1') {
      const own = await vodManager.getCategories(type).catch((e) => { if (type === 'series') return []; throw e; });
      return res.json({ categories: own });
    }
    const layout = await vodLayout(vodManager);
    if (type === 'series') return res.json({ categories: await seriesCategories(layout) });
    res.json({ categories: visible(layout.movies) });
  });

  const visible = (categories) => visibleVodCategories(categories, {
    hiddenCategories: appState.getHiddenVodCategories?.() ?? new Set(),
    hiddenLanguages: appState.getHiddenLanguages?.() ?? new Set(),
  });

  // The Series categories. When they were picked out of the movie section by
  // name (lib/seriesCategories.js) the portal has no "All" of its own for them,
  // so one is added: every show of those categories, put together
  // (SERIES_ALL in /listing).
  async function seriesCategories(layout) {
    const list = visible(layout.series);
    return layout.byName && list.length > 1 ? [{ id: SERIES_ALL, title: 'All' }, ...list] : list;
  }

  // The Series "All" above: each of the viewer's series categories read in
  // turn (the paced, cached getAllItems), every show listed once, in the order
  // read — append-only, so clients can ask for what's new from `from` on.
  const SERIES_ALL_TTL_MS = 60 * 60 * 1000;
  const combined = new Map();   // `${type}|${ids}` → { done, seen, current, complete, partial, at }
  function combinedListing(type, ids) {
    const key = `${type}|${ids.join(',')}`;
    const old = combined.get(key);
    if (old && (!old.complete || Date.now() - old.at < SERIES_ALL_TTL_MS)) return old;
    const c = { done: [], seen: new Set(), current: null, complete: false, partial: false, at: Date.now() };
    combined.set(key, c);
    (async () => {
      for (const id of ids) {
        c.current = id;
        try {
          const items = await appState.vodManager.getAllItems(type, id);
          if (appState.vodManager.peekListing?.(type, id)?.complete === false) c.partial = true;
          for (const item of items) if (!c.seen.has(item.id)) { c.seen.add(item.id); c.done.push(item); }
        } catch (e) {
          c.partial = true;
          log.warn(TAG, `series all: ${type}/${id}: ${e.message}`);
        }
      }
      c.current = null;
      c.complete = true;
      c.at = Date.now();
    })();
    return c;
  }

  // GET /api/vod/items?type=vod|series&category=X&page=1&search=&fav=0&sort=added|name
  router.get('/items', guard, async (req, res) => {
    const { vodManager } = appState;
    const { category, search = '', fav = '0', page = '1' } = req.query;
    let type = req.query.type === 'series' ? 'series' : 'vod';
    // A portal without a series section keeps its shows in the movie section.
    if (type === 'series') type = (await vodLayout(vodManager)).seriesType;

    if (!category) return res.status(400).json({ error: 'category is required' });

    const result = await vodManager.getItems({
      type,
      sort:       req.query.sort === 'name' ? 'name' : 'added',
      categoryId: category,
      page:       Math.max(1, parseInt(page, 10) || 1),
      search:     search.trim(),
      fav:        fav === '1' ? 1 : 0,
    });

    // Resolve screenshot URIs to absolute URLs server-side
    result.items = result.items.map(item => ({
      ...item,
      screenshotUrl: item.screenshotUri ? vodManager.resolveScreenshot(item.screenshotUri) : null,
    }));

    appState.touchActivity?.();
    res.json(result);
  });

  // GET /api/vod/listing?type=vod|series&category=X&from=N
  //
  // Every title of a category, for the VOD page's filters (year, genre,
  // rating…), which the portal can't apply itself. The first call starts the
  // paced read of the whole category (VodManager.getAllItems, cached for an
  // hour); each call answers with what has been read so far from `from` on, so
  // the page shows titles as they arrive and asks again until `complete`.
  router.get('/listing', guard, async (req, res) => {
    const { vodManager } = appState;
    const { category } = req.query;
    if (!category) return res.status(400).json({ error: 'category is required' });
    let type = req.query.type === 'series' ? 'series' : 'vod';
    if (type === 'series') type = (await vodLayout(vodManager)).seriesType;
    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    const withImages = (items) => items.map((item) => ({
      ...item,
      screenshotUrl: item.screenshotUri ? vodManager.resolveScreenshot(item.screenshotUri) : null,
    }));

    if (category === SERIES_ALL) {
      const ids = (await seriesCategories(await vodLayout(vodManager))).map((c) => c.id).filter((id) => id !== SERIES_ALL);
      const c = combinedListing(type, ids);
      // What's read so far: the categories done, then the one being read.
      const reading = c.current ? (vodManager.listingProgress(type, c.current)?.items ?? []).filter((i) => !c.seen.has(i.id)) : [];
      const items = [...c.done, ...reading];
      appState.touchActivity?.();
      return res.json({ items: withImages(items.slice(from)), loaded: items.length, total: c.complete ? items.length : 0, complete: c.complete, partial: c.complete && c.partial });
    }

    const done = vodManager.peekListing(type, category);
    if (done) {
      // partial: a page failed part-way; the rest is read again on a later visit.
      return res.json({ items: withImages(done.items.slice(from)), loaded: done.items.length, total: done.items.length, complete: true, partial: !done.complete });
    }
    vodManager.getAllItems(type, category).catch((e) => log.warn(TAG, `listing ${type}/${category}: ${e.message}`));
    const walk = vodManager.listingProgress(type, category);
    const items = walk ? walk.items.slice(0) : [];
    appState.touchActivity?.();
    res.json({ items: withImages(items.slice(from)), loaded: items.length, total: walk?.total ?? 0, complete: false });
  });

  // GET /api/vod/seasons/:movieId
  router.get('/seasons/:movieId', guard, async (req, res) => {
    const { vodManager } = appState;
    const seasons = await vodManager.getSeasons(req.params.movieId);
    const normalized = seasons.map(s => ({
      ...s,
      screenshotUrl: s.screenshotUri ? vodManager.resolveScreenshot(s.screenshotUri) : null,
    }));
    log.info(TAG, `seasons for movieId=${req.params.movieId}: ${normalized.length} seasons`);
    res.json({ seasons: normalized });
  });

  // GET /api/vod/episodes/:showId/:seasonId — episodes within a season
  router.get('/episodes/:showId/:seasonId', guard, async (req, res) => {
    const { vodManager } = appState;
    const episodes = await vodManager.getEpisodes(req.params.showId, req.params.seasonId);
    const normalized = episodes.map(e => ({
      ...e,
      screenshotUrl: e.screenshotUri ? vodManager.resolveScreenshot(e.screenshotUri) : null,
    }));
    log.info(TAG, `episodes for show=${req.params.showId} season=${req.params.seasonId}: ${normalized.length}`);
    res.json({ episodes: normalized });
  });

  // GET /api/vod/stream?videoId=X&cmd=<encoded>&series=0&seasonId=&episodeId=
  // Returns a /proxy/vod/stream URL so the browser never talks to the portal
  // directly — the proxy carries the session cookies and handles auth.
  router.get('/stream', guard, async (req, res) => {
    const { vodManager } = appState;
    const { videoId, cmd = '', series = '0', seasonId = '', episodeId = '' } = req.query;
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });

    // Resolve up front. The result is cached in VodManager, so the subsequent
    // /proxy/vod/stream fetch reuses it (no extra portal round-trip). Resolving
    // here lets us (a) fail fast with the real portal error and (b) detect HLS
    // so the client uses hls.js instead of native playback. Portal cmd
    // extensions like ".mpg" lie — the actual delivery is usually HLS, and
    // labelling the proxy URL ".mpg" made the player pick the native <video>
    // element, which double-fetched the m3u8 and tripped the CDN.
    let resolved;
    try {
      resolved = await vodManager.getStreamUrl(videoId, cmd || null, parseInt(series, 10) || 0, { seasonId, episodeId });
    } catch (e) {
      log.warn(TAG, `stream resolve failed for videoId=${videoId}: ${e.message}`);
      return res.status(502).json({ error: e.message });
    }

    const resolvedPath = resolved.split('?')[0].split('#')[0];
    const isHls = /\.(m3u8?|m3u)$/i.test(resolvedPath);

    const p = new URLSearchParams({ videoId });
    if (cmd)                        p.set('cmd', cmd);
    if (series && series !== '0')   p.set('series', series);
    if (seasonId)                   p.set('seasonId', seasonId);
    if (episodeId)                  p.set('episodeId', episodeId);

    // Extension drives the client's HLS-vs-native choice. Use .m3u8 for HLS so
    // the frontend routes it through hls.js; otherwise derive from the resolved
    // URL (falling back to .mp4).
    let ext = '.mp4';
    if (isHls) {
      ext = '.m3u8';
    } else {
      const m = resolvedPath.match(/\.([a-z0-9]+)$/i);
      if (m) ext = '.' + m[1].toLowerCase();
    }

    appState.touchActivity?.();
    res.json({ streamUrl: `/proxy/vod/stream${ext}?${p}`, videoId, isHls });
  });

  // ── What the viewer watched (viewers/WatchStore.js) ──────────────────────────
  // Per viewer, so it follows them to any device, and per portal: ids mean
  // nothing on another portal. No session guard — it outlives a disconnect.
  //   GET    /api/vod/watch              — { progress, history, watched }
  //   PUT    /api/vod/watch              — a position reached { key, title, … }
  //   DELETE /api/vod/watch/history/:id  — a title out of Recently watched
  //   DELETE /api/vod/watch/history      — Recently watched cleared
  //   PUT    /api/vod/watch/list         — a title onto My List { id, name, … }
  //   DELETE /api/vod/watch/list/:id     — a title off My List
  //   PUT    /api/vod/watch/list/:id/completed — { completed } To watch ⇄ Completed
  const portalOf = () => appState.client?.getBasePath?.() || '';
  const watchAnswer = (fn) => (req, res) => {
    if (!watchStore) return res.json({ progress: [], history: [], watched: [] });
    try {
      res.json(fn(req));
    } catch (e) {
      log.error(TAG, `watch: ${e.message}`);
      res.status(500).json({ error: 'Could not save what you watched.' });
    }
  };
  router.use('/watch', refuseIfGone);
  router.get('/watch', watchAnswer((req) => watchStore.get(req.viewer.id, portalOf())));
  router.put('/watch', watchAnswer((req) => watchStore.record(req.viewer.id, portalOf(), req.body ?? {})));
  router.delete('/watch/history/:id', watchAnswer((req) => watchStore.removeTitle(req.viewer.id, portalOf(), req.params.id)));
  router.delete('/watch/history', watchAnswer((req) => watchStore.clearHistory(req.viewer.id, portalOf())));
  router.put('/watch/list', watchAnswer((req) => watchStore.addToList(req.viewer.id, portalOf(), req.body ?? {})));
  router.delete('/watch/list/:id', watchAnswer((req) => watchStore.removeFromList(req.viewer.id, portalOf(), req.params.id)));
  router.put('/watch/list/:id/completed', watchAnswer((req) => watchStore.setListCompleted(req.viewer.id, portalOf(), req.params.id, req.body?.completed === true)));

  return router;
};
