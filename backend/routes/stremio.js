// routes/stremio.js
// StalkerWeb as a Stremio addon: the portal's live TV, movies and series, by
// category, in Stremio's Discover and search.
//
//   GET /stremio/manifest.json                      addon description + catalogs
//   GET /stremio/catalog/:type/:id[/:extra].json    a page of a catalog
//   GET /stremio/meta/:type/:id.json                one title (a show's episodes)
//   GET /stremio/stream/:type/:id.json              where to play it
//
// Install in Stremio from <address>/stremio/manifest.json. Stremio only loads
// addons over HTTPS, except from 127.0.0.1 on the same computer — see the
// README for serving StalkerWeb over HTTPS.
//
// There is one catalog per kind (tv, movie, series); the portal's categories
// are its "genre" choices, which Stremio shows as a dropdown in Discover.
// Streams point at the existing /proxy routes, like every other export, and
// the catalog itself (filters, listing, caches) is shared with the Xtream API
// — see lib/catalog.js.
//
// Ids: sw:live:<channel id>, sw:movie:<video id>, sw:series:<show id>, and
// sw:ep:<episode id> for a show's episodes (the stable ids from XtreamIdStore).

'use strict';

const express = require('express');
const log = require('../logger');
const { createCatalog } = require('../lib/catalog');
const TAG = 'stremio';

const PAGE_SIZE = 100;            // Stremio pages catalogs by 100 (skip = 0, 100, 200…)
const ID_PREFIX = 'sw:';
const CATALOGS = {
  tv:     { id: 'sw-live',   name: 'StalkerWeb Live TV' },
  movie:  { id: 'sw-movies', name: 'StalkerWeb Movies' },
  series: { id: 'sw-series', name: 'StalkerWeb Series' },
};

// The extra segment of a catalog URL, "genre=Kids%20%26%20Family&skip=100" →
// { genre: 'Kids & Family', skip: '100' }. Read from the raw URL: Express
// decodes route params first, which would turn an encoded "&" inside a genre
// name into a separator.
function parseExtra(req) {
  if (!req.params.extra) return {};
  const path = req.originalUrl.split('?')[0];
  const raw = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
  return Object.fromEntries(new URLSearchParams(raw));
}

const year = (y) => (/^\d{4}$/.test(String(y)) ? String(y) : undefined);

module.exports = function stremioModule(appState, { logoManager = null, idStore, catalog = null, version = '1.0.0' } = {}) {
  const router = express.Router();
  const cat = catalog ?? createCatalog(appState, { logoManager, idStore });

  const baseOf = (req) => `${req.protocol}://${req.get('host')}`;
  const connected = () => !!(appState.channelManager && appState.vodManager);

  // Category name → id for each kind, for the genre dropdowns. Names are what
  // Stremio sends back, so they must be unique; a repeat gets its id appended.
  async function genres() {
    const out = { tv: [], movie: [], series: [] };
    if (!connected()) return out;
    const named = (cats) => {
      const seen = new Set();
      return cats.map((c) => {
        let name = c.title ?? c.name;
        if (seen.has(name)) name = `${name} (${c.id})`;
        seen.add(name);
        return { id: String(c.id), name };
      });
    };
    out.tv = named(cat.liveData().categories);
    try { out.movie = named(await cat.visibleCategories('vod')); } catch (e) { log.warn(TAG, `movie categories: ${e.message}`); }
    try { out.series = named((await cat.seriesSource()).categories); } catch (e) { log.warn(TAG, `series categories: ${e.message}`); }
    return out;
  }

  // ── Manifest ───────────────────────────────────────────────────────────────

  router.get('/manifest.json', async (req, res) => {
    const g = await genres();
    const catalogFor = (type) => ({
      type,
      id: CATALOGS[type].id,
      name: CATALOGS[type].name,
      extra: [
        { name: 'genre', options: g[type].map((x) => x.name), isRequired: false },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    });
    res.set('Cache-Control', 'no-cache');
    res.json({
      id: 'com.stalkerweb.addon',
      version,
      name: 'StalkerWeb',
      description: 'Live TV, movies and series from your Stalker portal, by category.',
      logo: `${baseOf(req)}/favicon.svg`,
      resources: ['catalog', 'meta', 'stream'],
      types: ['tv', 'movie', 'series'],
      idPrefixes: [ID_PREFIX],
      catalogs: [catalogFor('tv'), catalogFor('movie'), catalogFor('series')],
    });
  });

  // ── Catalogs ───────────────────────────────────────────────────────────────

  const liveMeta = (ch) => ({
    id: `${ID_PREFIX}live:${ch.uniqueId}`,
    type: 'tv',
    name: ch.name,
    poster: cat.logoFor(ch) || undefined,
    posterShape: 'square',
    logo: cat.logoFor(ch) || undefined,
  });

  const titleMeta = (base, type, item) => ({
    id: `${ID_PREFIX}${type}:${item.id}`,
    type,
    name: item.name,
    poster: cat.posterFor(base, item.screenshotUri) || undefined,
    posterShape: 'poster',
    description: item.description || undefined,
    releaseInfo: year(item.year),
  });

  async function catalogMetas(req, type, extra) {
    const base = baseOf(req);
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
    const search = (extra.search || '').trim();
    const g = (await genres())[type];
    const genre = extra.genre ? g.find((x) => x.name === extra.genre) : null;
    if (extra.genre && !genre) return [];

    if (type === 'tv') {
      let streams = cat.liveData(genre?.id).streams;
      if (search) {
        const q = search.toLowerCase();
        streams = streams.filter(({ ch }) => ch.name.toLowerCase().includes(q));
      }
      return streams.slice(skip, skip + PAGE_SIZE).map(({ ch }) => liveMeta(ch));
    }

    // Movies and series: the portal's search, or one category. With no genre
    // chosen (Stremio's home board) the first category stands in — listing
    // every category at once can take minutes on a big portal.
    let rows;
    if (search) {
      rows = skip ? [] : await cat.searchTitles(type, search);
    } else {
      const categoryId = genre?.id ?? g[0]?.id;
      if (!categoryId) return [];
      rows = type === 'movie' ? await cat.listMovies(categoryId) : await cat.listShows(categoryId);
    }
    return rows.slice(skip, skip + PAGE_SIZE).map(({ item }) => titleMeta(base, type, item));
  }

  async function catalogRoute(req, res) {
    const { type, id } = req.params;
    if (!CATALOGS[type] || CATALOGS[type].id !== id) return res.status(404).json({ metas: [] });
    if (!connected()) return res.json({ metas: [] });
    try {
      const metas = await catalogMetas(req, type, parseExtra(req));
      appState.touchActivity?.();
      res.json({ metas, cacheMaxAge: 15 * 60 });
    } catch (e) {
      log.error(TAG, `catalog ${type}/${id} failed: ${e.message}`);
      res.status(502).json({ metas: [], error: e.message });
    }
  }

  router.get('/catalog/:type/:id.json', catalogRoute);
  router.get('/catalog/:type/:id/:extra.json', catalogRoute);

  // ── Meta ───────────────────────────────────────────────────────────────────

  const parseId = (id) => {
    const m = /^sw:(live|movie|series|ep):(.+)$/.exec(String(id));
    return m ? { kind: m[1], value: m[2] } : null;
  };

  router.get('/meta/:type/:id.json', async (req, res) => {
    const ref = parseId(req.params.id);
    if (!ref || !connected()) return res.status(404).json({ meta: null });
    const base = baseOf(req);
    try {
      if (ref.kind === 'live') {
        const ch = appState.channelManager.getChannel(ref.value);
        if (!ch) return res.status(404).json({ meta: null });
        return res.json({ meta: { ...liveMeta(ch), background: cat.logoFor(ch) || undefined } });
      }
      if (ref.kind === 'movie') {
        const item = cat.findMovie(ref.value);
        // Known from a listing; otherwise (e.g. opened from Stremio's library
        // after a restart) a bare entry that still plays.
        const meta = item ? titleMeta(base, 'movie', item) : { id: req.params.id, type: 'movie', name: 'Movie' };
        return res.json({ meta: { ...meta, background: meta.poster } });
      }
      if (ref.kind === 'series') {
        const show = cat.findShow(ref.value);
        const seasons = await cat.seasonsOf(ref.value);
        const released = new Date(Date.parse(show?.added) || 0).toISOString();
        const videos = seasons.flatMap((s) => s.episodes.map((e) => ({
          id: `${ID_PREFIX}ep:${e.id}`,
          title: e.title,
          season: s.number,
          episode: e.number,
          released,
          thumbnail: cat.posterFor(base, e.imageUri) || undefined,
        })));
        const meta = show ? titleMeta(base, 'series', show) : { id: req.params.id, type: 'series', name: 'Series' };
        appState.touchActivity?.();
        return res.json({ meta: { ...meta, background: meta.poster, videos } });
      }
      return res.status(404).json({ meta: null });
    } catch (e) {
      log.error(TAG, `meta ${req.params.id} failed: ${e.message}`);
      return res.status(502).json({ meta: null, error: e.message });
    }
  });

  // ── Streams ────────────────────────────────────────────────────────────────

  router.get('/stream/:type/:id.json', (req, res) => {
    const ref = parseId(req.params.id);
    if (!ref || !connected()) return res.json({ streams: [] });

    let path;
    let title;
    if (ref.kind === 'live') {
      const ch = appState.channelManager.getChannel(ref.value);
      if (!ch) return res.json({ streams: [] });
      path = cat.liveProxyPath(ch.uniqueId);
      title = ch.name;
    } else if (ref.kind === 'movie') {
      path = cat.movieProxyPath(ref.value);
      title = cat.findMovie(ref.value)?.name || 'Play';
    } else if (ref.kind === 'ep') {
      const ep = cat.episodeProxyPath(ref.value);
      if (ep.error) return res.json({ streams: [] });
      path = ep.path;
      title = 'Play';
    } else {
      return res.json({ streams: [] });
    }

    res.json({
      streams: [{
        url: `${baseOf(req)}/proxy${path}`,
        name: 'StalkerWeb',
        title,
        // Portal streams are HLS or MPEG-TS, not browser-ready MP4: Stremio's
        // web player routes them through its streaming server.
        behaviorHints: { notWebReady: true },
      }],
    });
  });

  return router;
};
