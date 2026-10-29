// routes/vod.js
// GET    /api/vod/categories?type=vod|series
// GET    /api/vod/items?type=vod|series&category=X&page=1&search=&fav=0
// GET    /api/vod/seasons/:movieId
// GET    /api/vod/stream?videoId=X&cmd=<encoded>&series=0
// GET    /api/vod/listing?type&category&from — a whole category, as it is read
// GET/PUT/DELETE /api/vod/watch…  — what the viewer watched (see below)
// GET    /api/vod/skip?videoId&name&year&season&episode&movie — intro, recap, credits
// PUT    /api/vod/skip/match/:videoId { imdbId }  — the show's IMDb match set by hand
// GET    /api/vod/subtitles?videoId&name&year&season&episode&movie — online subtitles
// GET    /api/vod/subtitles/file/:fileId.vtt?offset — one of them, as WebVTT

'use strict';

const express = require('express');
const router  = express.Router();
const sessionMiddleware = require('../middleware/session');
const { visibleVodCategories, isAllCategory } = require('../lib/vodCategoryFilter');
const { vodLayout } = require('../lib/seriesCategories');
const { refuseIfGone } = require('./viewers');
const { isAdult } = require('../lib/exportFilter');

// The "All" StalkerWeb adds to Movies or Series when the portal's own can't
// be shown (see tabCategories below), by tab.
const COMBINED_ALL = { vod: 'movies:all', series: 'series:all' };
const tabOfCombined = (id) => Object.keys(COMBINED_ALL).find((tab) => COMBINED_ALL[tab] === id) ?? null;

const log = require('../logger');
const { castLink, vodContentType } = require('../lib/castLink');
const { vodKey } = require('../lib/activity');
const TAG = 'vod';

module.exports = function vodRoutes(appState, config, { watchStore = null, skipSegments = null, subtitles = null } = {}) {
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
    res.json({ categories: tabCategories(type, await vodLayout(vodManager)) });
  });

  // The viewer's categories: hidden ones left out, and adult ones unless the
  // viewer may see them — here, so an added "All" never takes an adult one in.
  const visible = (categories) => {
    const shown = visibleVodCategories(categories, {
      hiddenCategories: appState.getHiddenVodCategories?.() ?? new Set(),
      hiddenLanguages: appState.getHiddenLanguages?.() ?? new Set(),
    });
    return appState.getShowAdult?.() === true ? shown : shown.filter((c) => !isAdult(c.title));
  };

  // A tab's categories (Movies 'vod' or 'series'). When the portal's own "All"
  // can't be shown — the viewer hides some categories (its titles carry no
  // category, so it would bring them back), or the shows were picked out of
  // the movie section by name (lib/seriesCategories.js), which has none for
  // them — an "All" is added: every title of the viewer's categories, put
  // together (COMBINED_ALL; read in /listing and /items).
  function tabCategories(tab, layout) {
    const list = visible(tab === 'series' ? layout.series : layout.movies);
    return !list.some(isAllCategory) && list.length > 1 ? [{ id: COMBINED_ALL[tab], title: 'All' }, ...list] : list;
  }
  async function combinedIds(tab) {
    return tabCategories(tab, await vodLayout(appState.vodManager)).map((c) => c.id).filter((id) => !tabOfCombined(id));
  }

  // That "All": each of the viewer's categories of the tab read in turn (the
  // paced, cached getAllItems), every title listed once, in the order read —
  // append-only, so clients can ask for what's new from `from` on.
  // Kept an hour, like the listings it's made of — or a couple of minutes when
  // a category couldn't be read, so a retry soon gets another go. Keyed by
  // portal: another connection's categories can have the same ids.
  const COMBINED_TTL_MS = 60 * 60 * 1000;
  const COMBINED_PARTIAL_TTL_MS = 2 * 60 * 1000;
  const combined = new Map();   // `${portal}|${type}|${ids}` → { done, seen, current, complete, partial, at }
  function combinedListing(type, ids) {
    const vm = appState.vodManager;
    const key = `${appState.client?.getBasePath?.() ?? ''}|${type}|${ids.join(',')}`;
    const old = combined.get(key);
    const ttl = old?.partial ? COMBINED_PARTIAL_TTL_MS : COMBINED_TTL_MS;
    if (old && (!old.complete || Date.now() - old.at < ttl)) return old;
    const c = { done: [], seen: new Set(), current: null, complete: false, partial: false, at: Date.now() };
    combined.set(key, c);
    (async () => {
      for (const id of ids) {
        if (appState.vodManager !== vm) { c.partial = true; break; }   // the connection changed
        c.current = id;
        try {
          const items = await vm.getAllItems(type, id);
          if (vm.peekListing?.(type, id)?.complete === false) c.partial = true;
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

    if (tabOfCombined(category)) return res.json(await combinedPage(tabOfCombined(category), type, req.query));

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

  // A page of an added "All" for clients that page through /items (the
  // Android app): what the combined listing has read so far, searched and
  // sorted here. While it's still being read, one more page is promised, so a
  // client asks again.
  const COMBINED_PAGE = 42;
  async function combinedPage(tab, type, { search = '', page = '1', sort } = {}) {
    const { vodManager } = appState;
    const c = combinedListing(type, await combinedIds(tab));
    let items = c.done.slice();
    const q = String(search).trim().toLowerCase();
    if (q) items = items.filter((i) => (i.name ?? '').toLowerCase().includes(q));
    if (sort === 'name') items.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
    const n = Math.max(1, parseInt(page, 10) || 1);
    const totalPages = Math.max(1, Math.ceil(items.length / COMBINED_PAGE)) + (c.complete ? 0 : 1);
    appState.touchActivity?.();
    return {
      items: items.slice((n - 1) * COMBINED_PAGE, n * COMBINED_PAGE).map((item) => ({
        ...item,
        screenshotUrl: item.screenshotUri ? vodManager.resolveScreenshot(item.screenshotUri) : null,
      })),
      totalItems: items.length,
      totalPages,
      page: n,
    };
  }

  // A listing whose read failed (first page) — remembered briefly, so /listing
  // can say so instead of answering "not yet" and starting the read again on
  // every poll.
  const LISTING_FAILURE_MS = 60 * 1000;
  const listingFailures = new Map();   // `${type}|${category}` → { message, at }

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

    if (tabOfCombined(category)) {
      const c = combinedListing(type, await combinedIds(tabOfCombined(category)));
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
    const failKey = `${type}|${category}`;
    const failed = listingFailures.get(failKey);
    if (failed && Date.now() - failed.at < LISTING_FAILURE_MS && !vodManager.listingProgress(type, category)) {
      return res.json({ items: [], loaded: 0, total: 0, complete: true, partial: true, error: `Couldn't read this category: ${failed.message}` });
    }
    vodManager.getAllItems(type, category)
      .then(() => listingFailures.delete(failKey))
      .catch((e) => {
        listingFailures.set(failKey, { message: e.message, at: Date.now() });
        log.warn(TAG, `listing ${type}/${category}: ${e.message}`);
      });
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
  // The /proxy/vod/stream link for a movie or episode (and whether it's HLS),
  // resolved now — see /stream below. Throws { status, message } on failure.
  async function vodStreamLink(query) {
    const { vodManager } = appState;
    const { videoId, cmd = '', series = '0', seasonId = '', episodeId = '' } = query;
    if (!videoId) throw Object.assign(new Error('videoId is required'), { status: 400 });

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
      throw Object.assign(new Error(e.message), { status: 502 });
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
    return { path: `/proxy/vod/stream${ext}?${p}`, videoId: String(videoId), isHls, ext };
  }

  // Settings → Activity: a movie or episode keyed as Continue Watching keys it.
  const claimVod = (req, { cast = false, title = '', subtitle = '' } = {}) => {
    appState.activity?.claim({ ip: req.ip, kind: 'vod', id: vodKey(req.query), viewerId: req.viewer?.id, cast, title, subtitle });
  };

  router.get('/stream', guard, async (req, res) => {
    try {
      const link = await vodStreamLink(req.query);
      claimVod(req);
      res.json({ streamUrl: link.path, videoId: link.videoId, isHls: link.isHls });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // GET /api/vod/cast?videoId=… (as /stream): the link a cast device opens —
  // the same stream, under the playback-only share token (lib/castLink.js).
  // &image=/api/logos/render?… adds the poster as imageUrl, a link the TV can load.
  router.get('/cast', guard, async (req, res) => {
    try {
      const link = await vodStreamLink(req.query);
      claimVod(req, { cast: true });
      res.json(await castLink(req, appState.shareToken, link.path, link.isHls ? 'application/x-mpegURL' : vodContentType(link.ext), false,
        typeof req.query.image === 'string' ? req.query.image : null));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // ── Skip intro / recap / credits (lib/skipSegments.js) ──────────────────────
  // GET /api/vod/skip?videoId=&name=&year=&season=&episode=&movie=1
  //   → { imdbId, match, intro, recap, outro, autoSkip }: each part { start, end }
  //   in seconds or null; autoSkip is the viewer's choice. `videoId` is the
  //   movie or show, `name` its portal title; season and episode numbers for
  //   an episode. Nothing to skip when the IMDb or IntroDB lookup fails.
  router.get('/skip', refuseIfGone, async (req, res) => {
    const q = req.query;
    const autoSkip = req.viewer?.autoSkip === true;
    if (!skipSegments) return res.json({ imdbId: null, match: null, intro: null, recap: null, outro: null, autoSkip });
    const found = await skipSegments.lookup({
      portal: portalOf(), videoId: q.videoId, name: q.name, year: q.year,
      season: q.season, episode: q.episode, isMovie: q.movie === '1',
    });
    res.json({ ...found, autoSkip });
  });

  // PUT /api/vod/skip/match/:videoId { imdbId: "tt…" | "off" | null } — the
  // show is this IMDb title; "off": never skip in it; null: find it by name.
  router.put('/skip/match/:videoId', refuseIfGone, (req, res) => {
    if (!skipSegments) return res.status(503).json({ error: 'Skipping is not available.' });
    try {
      res.json(skipSegments.setMatch(portalOf(), req.params.videoId, req.body?.imdbId ?? null));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Online subtitles (lib/subtitles.js) ─────────────────────────────────────
  // GET /api/vod/subtitles?videoId=&name=&year=&season=&episode=&movie=1
  //   → { configured, provider, imdbId, results: [{ fileId, language, label,
  //   downloads, hearingImpaired, machine, source }], error? } — found by the IMDb id skip intro
  //   matched. Not configured (no API key): an empty list, and says so.
  router.get('/subtitles', refuseIfGone, async (req, res) => {
    const q = req.query;
    const provider = subtitles?.providerName?.() ?? '';
    if (!subtitles?.configured() || !skipSegments) return res.json({ configured: false, provider, imdbId: null, results: [] });
    const isMovie = q.movie === '1';
    try {
      const t = await skipSegments.titleFor({ portal: portalOf(), videoId: q.videoId, name: q.name, year: q.year, season: q.season, episode: q.episode, isMovie });
      if (!t.imdbId) return res.json({ configured: true, provider, imdbId: null, results: [], error: "This title wasn't found on IMDb." });
      if (!isMovie && (t.season === null || !t.episode)) return res.json({ configured: true, provider, imdbId: t.imdbId, results: [], error: "This episode's season or number isn't known." });
      const results = await subtitles.search({ imdbId: t.imdbId, season: t.season, episode: t.episode, isMovie });
      res.json({ configured: true, provider, imdbId: t.imdbId, results });
    } catch (e) {
      log.warn(TAG, `subtitles: ${e.message}`);
      res.json({ configured: true, provider, imdbId: null, results: [], error: e.message });
    }
  });

  // GET /api/vod/subtitles/file/:fileId.vtt?offset=1.5 — readable with the
  // playback token too (lib/access.js): the apps' player fetches it as it
  // does the stream.
  router.get('/subtitles/file/:file', async (req, res) => {
    const m = /^(\d{1,12}|w[A-Za-z0-9_-]{1,60})\.vtt$/.exec(req.params.file);
    if (!m || !subtitles) return res.status(404).json({ error: 'No such subtitle file.' });
    const offset = Math.max(-600, Math.min(600, Number(req.query.offset) || 0));
    try {
      const vtt = await subtitles.webVtt(m[1], offset);
      res.set('Cache-Control', 'private, max-age=3600').type('text/vtt; charset=utf-8').send(vtt);
    } catch (e) {
      log.warn(TAG, `subtitle file ${m[1]}: ${e.message}`);
      res.status(e.status || 502).json({ error: e.message });
    }
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
  //   PUT    /api/vod/watch/episodes/:key — { watched } an episode ticked by hand
  const portalOf = () => appState.client?.getBasePath?.() || '';
  const watchAnswer = (fn) => (req, res) => {
    if (!watchStore) return res.json({ progress: [], history: [], watched: [], watchedEpisodes: [] });
    try {
      res.json(fn(req));
    } catch (e) {
      log.error(TAG, `watch: ${e.message}`);
      res.status(500).json({ error: 'Could not save what you watched.' });
    }
  };
  router.use('/watch', refuseIfGone);
  router.get('/watch', watchAnswer((req) => watchStore.get(req.viewer.id, portalOf())));
  router.put('/watch', watchAnswer((req) => {
    // Every 10 s while it plays: the title and whose it is, for Settings → Activity.
    const b = req.body ?? {};
    if (b.key && appState.activity) {
      appState.activity.claim({ ip: req.ip, kind: 'vod', id: String(b.key), viewerId: req.viewer.id, title: b.title, subtitle: b.episodeTitle });
      // And it's still playing: an HLS movie between requests, or one the
      // proxy sent to a CDN (the browser and the app save from the same device that plays).
      appState.activity.touch({ ip: req.ip, ua: req.get('user-agent') || '', kind: 'vod', id: String(b.key), viewerId: req.viewer.id })();
    }
    return watchStore.record(req.viewer.id, portalOf(), b);
  }));
  router.delete('/watch/history/:id', watchAnswer((req) => watchStore.removeTitle(req.viewer.id, portalOf(), req.params.id)));
  router.delete('/watch/history', watchAnswer((req) => watchStore.clearHistory(req.viewer.id, portalOf())));
  router.put('/watch/list', watchAnswer((req) => watchStore.addToList(req.viewer.id, portalOf(), req.body ?? {})));
  router.delete('/watch/list/:id', watchAnswer((req) => watchStore.removeFromList(req.viewer.id, portalOf(), req.params.id)));
  router.put('/watch/episodes/:key', watchAnswer((req) => watchStore.setEpisodeWatched(req.viewer.id, portalOf(), req.params.key, req.body?.watched === true)));
  router.put('/watch/list/:id/completed', watchAnswer((req) => watchStore.setListCompleted(req.viewer.id, portalOf(), req.params.id, req.body?.completed === true)));

  return router;
};
