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
// Ids carry a short tag of the portal they came from, so an item saved in
// Stremio's library never plays another portal's title with the same id:
//   sw:live:<tag>:<channel id>, sw:movie:<tag>:<video id>,
//   sw:series:<tag>:<show id>, and sw:ep:<episode id> for episodes (their
//   stable ids from XtreamIdStore already record the portal).

'use strict';

const crypto = require('crypto');
const express = require('express');
const log = require('../logger');
const { createCatalog } = require('../lib/catalog');
const { readyForClient } = require('../lib/clientSession');
const { baseUrl } = require('../lib/publicUrl');
const TAG = 'stremio';

const PAGE_SIZE = 100;            // Stremio pages catalogs by 100 (skip = 0, 100, 200…)
const GENRES_TTL_MS = 60 * 1000;  // category lists per kind, reused across requests
const CHANNEL_WAIT_MS = 10_000;   // live ids right after a restart, while channels load
const CATALOGS = {
  tv:     { id: 'sw-live',   name: 'StalkerWeb Live TV' },
  movie:  { id: 'sw-movies', name: 'StalkerWeb Movies' },
  series: { id: 'sw-series', name: 'StalkerWeb Series' },
};

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

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

  const connected = () => !!(appState.channelManager && appState.vodManager);
  const portalTag = () => hash(cat.currentPortal()).slice(0, 8);

  // Outside clients arrive long after the idle auto-disconnect; reconnect
  // first so the addon keeps working without anyone opening the web UI.
  router.use(async (_req, _res, next) => {
    await readyForClient(appState, { waitForChannels: true, timeoutMs: 20_000 });
    next();
  });

  // ── Genres (the portal's categories) ───────────────────────────────────────

  // Category name → id for one kind, for its genre dropdown. Names are what
  // Stremio sends back, so they must be unique; a repeat gets its id appended.
  // Cached briefly per portal: every catalog page needs its own kind's list,
  // and rebuilding it re-read settings and re-sorted every channel.
  const genreCache = new Map(); // `${portal}|${kind}` → { value, ts }
  async function genresFor(kind) {
    if (!connected()) return { list: [], required: false };
    const key = `${cat.currentPortal()}|${kind}`;
    const hit = genreCache.get(key);
    if (hit && Date.now() - hit.ts < GENRES_TTL_MS) return hit.value;

    let cats = [];
    let required = false;
    try {
      if (kind === 'tv') cats = cat.liveData().categories;
      else if (kind === 'movie') cats = await cat.visibleCategories('vod');
      else {
        const src = await cat.seriesSource();
        cats = src.categories;
        // Without a series section the "series" categories are the movie
        // ones, most holding no shows — so there is no sensible default for
        // the home board, and a category must be picked in Discover.
        required = !src.all;
      }
    } catch (e) {
      log.warn(TAG, `${kind} categories: ${e.message}`);
    }
    const seen = new Set();
    const list = cats.map((c) => {
      let name = c.title ?? c.name;
      if (seen.has(name)) name = `${name} (${c.id})`;
      seen.add(name);
      return { id: String(c.id), name };
    });
    const value = { list, required };
    genreCache.set(key, { value, ts: Date.now() });
    return value;
  }

  // The genre Stremio sent, matched forgivingly: Stremio keeps the options of
  // the manifest it installed, which may predate a rename or a re-suffixed
  // duplicate.
  function findGenre(list, name) {
    const lower = name.toLowerCase();
    const bare = (n) => n.replace(/ \([^)]*\)$/, '').toLowerCase();
    return list.find((g) => g.name === name)
      ?? list.find((g) => g.name.toLowerCase() === lower)
      ?? list.find((g) => bare(g.name) === bare(name));
  }

  // ── Manifest ───────────────────────────────────────────────────────────────

  router.get('/manifest.json', async (req, res) => {
    const g = { tv: await genresFor('tv'), movie: await genresFor('movie'), series: await genresFor('series') };
    const catalogFor = (type) => ({
      type,
      id: CATALOGS[type].id,
      name: CATALOGS[type].name,
      extra: [
        { name: 'genre', options: g[type].list.map((x) => x.name), isRequired: g[type].required },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    });
    // The patch number follows the portal and its categories, so Stremio sees
    // a new version — and refreshes its stored genre lists — when they change.
    const [major = '1', minor = '0'] = String(version).split('.');
    const patch = parseInt(hash(JSON.stringify([portalTag(), g])).slice(0, 7), 16);
    res.set('Cache-Control', 'no-cache');
    res.json({
      id: 'com.stalkerweb.addon',
      version: `${major}.${minor}.${patch}`,
      name: 'StalkerWeb',
      description: 'Live TV, movies and series from your Stalker portal, by category.',
      logo: `${baseUrl(req)}/favicon.svg`,
      resources: ['catalog', 'meta', 'stream'],
      types: ['tv', 'movie', 'series'],
      idPrefixes: ['sw:'],
      catalogs: [catalogFor('tv'), catalogFor('movie'), catalogFor('series')],
    });
  });

  // ── Catalogs ───────────────────────────────────────────────────────────────

  // Images go through this server, like the web UI's: portal images are often
  // http-only (blocked in Stremio Web) or need the portal session.
  const imageUrl = (base, src) => {
    if (!src) return undefined;
    if (src.startsWith('/')) return base + src;
    if (/^https?:\/\//i.test(src)) return `${base}/api/logos/render?url=${encodeURIComponent(src)}`;
    return undefined;
  };

  const liveMeta = (base, ch) => {
    const logo = imageUrl(base, cat.logoFor(ch));
    return {
      id: `sw:live:${portalTag()}:${ch.uniqueId}`,
      type: 'tv',
      name: ch.name,
      poster: logo,
      posterShape: 'square',
      logo,
    };
  };

  const titleMeta = (base, type, item) => ({
    id: `sw:${type}:${portalTag()}:${item.id}`,
    type,
    name: item.name,
    poster: cat.posterFor(base, item.screenshotUri) || undefined,
    posterShape: 'poster',
    description: item.description || undefined,
    releaseInfo: year(item.year),
  });

  async function catalogMetas(req, type, extra) {
    const base = baseUrl(req);
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
    const search = (extra.search || '').trim();
    const { list } = await genresFor(type);
    const genre = extra.genre ? findGenre(list, extra.genre) : null;
    if (extra.genre && !genre) return [];

    if (type === 'tv') {
      let streams = cat.liveData(genre?.id).streams;
      if (search) {
        const q = search.toLowerCase();
        streams = streams.filter(({ ch }) => ch.name.toLowerCase().includes(q));
      }
      return streams.slice(skip, skip + PAGE_SIZE).map(({ ch }) => liveMeta(base, ch));
    }

    // Movies and series: the portal's search, or one screen of a category.
    // With no genre chosen (Stremio's home board) the first category stands in.
    let rows;
    if (search) {
      rows = skip ? [] : await cat.searchTitles(type, search);
    } else {
      const categoryId = genre?.id ?? list[0]?.id;
      if (!categoryId) return [];
      rows = await cat.pageOfTitles(type, categoryId, skip, PAGE_SIZE);
    }
    return rows.map(({ item }) => titleMeta(base, type, item));
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

  // ── Ids ────────────────────────────────────────────────────────────────────

  // { kind, value } for an id of the connected portal; { foreign: true } for
  // one from another portal; null for anything else.
  function parseId(id) {
    const ep = /^sw:ep:(.+)$/.exec(String(id));
    if (ep) return { kind: 'ep', value: ep[1] };
    const m = /^sw:(live|movie|series):([0-9a-f]{8}):(.+)$/.exec(String(id));
    if (!m) return null;
    return m[2] === portalTag() ? { kind: m[1], value: m[3] } : { foreign: true };
  }

  // Live ids can arrive right after a restart, before the channel list is in.
  const waitChannel = (id) => appState.channelManager.waitForChannel?.(id, CHANNEL_WAIT_MS)
    ?? Promise.resolve(appState.channelManager.getChannel(id));

  // ── Meta ───────────────────────────────────────────────────────────────────

  router.get('/meta/:type/:id.json', async (req, res) => {
    const ref = parseId(req.params.id);
    if (!ref || !connected()) return res.status(404).json({ meta: null });
    const base = baseUrl(req);
    if (ref.foreign) {
      return res.json({ meta: { id: req.params.id, type: req.params.type, name: 'From another portal', description: 'Saved while a different portal was connected. Connect that portal again to play it.' } });
    }
    try {
      if (ref.kind === 'live') {
        const ch = await waitChannel(ref.value);
        if (!ch) return res.status(404).json({ meta: null });
        const meta = liveMeta(base, ch);
        return res.json({ meta: { ...meta, background: meta.logo } });
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
          id: `sw:ep:${e.id}`,
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

  router.get('/stream/:type/:id.json', async (req, res) => {
    const ref = parseId(req.params.id);
    if (!ref || ref.foreign || !connected()) return res.json({ streams: [] });

    let path;
    let title;
    if (ref.kind === 'live') {
      const ch = await waitChannel(ref.value);
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
        url: `${baseUrl(req)}/proxy${path}`,
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
