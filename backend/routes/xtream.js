// routes/xtream.js
// An Xtream Codes compatible API over the connected Stalker portal.
//
// Xtream is the other common IPTV account type. Players that speak it
// (Jellyfin's Xtream plugin, TiviMate, IPTV Smarters…) browse live TV, movies
// and series by category — the layout of a Stalker portal, which an M3U can't
// carry. Point such a player at this server's address with any username and
// password.
//
//   GET /player_api.php?username=&password=[&action=…]   account + catalog
//   GET /live/<user>/<pass>/<streamId>.<ext>             live channel
//   GET /movie/<user>/<pass>/<streamId>.<ext>            movie
//   GET /series/<user>/<pass>/<episodeId>.<ext>          series episode
//   GET /get.php                                         M3U  (same as /api/m3u)
//   GET /xmltv.php                                       XMLTV (same as /api/xmltv)
//
// Streams are handed to the existing /proxy routes, so tokens, retries and HLS
// rewriting behave exactly as they do for the web player. Hidden genres and
// languages and adult content are left out, as in the other exports.

'use strict';

const express = require('express');
const log = require('../logger');
const { groupChannels } = require('./m3u');
const { isAdult } = require('../lib/exportFilter');
const { isLanguageDisabled } = require('../lib/languages');
const TAG = 'xtream';

const ALL_CATEGORIES_ID = '*';              // the portal's "everything" pseudo-category
const SYNTHETIC_CATEGORY_BASE = 900000;     // live categories with no numeric portal id
const SERIES_INFO_TTL_MS = 60 * 60 * 1000;
const CONTAINER = 'mp4';

const asNumber = (id) => (/^-?\d+$/.test(String(id)) ? Number(id) : String(id));
const toUnix   = (date) => { const t = Date.parse(date); return Number.isFinite(t) ? String(Math.floor(t / 1000)) : '0'; };
const pad      = (n) => String(n).padStart(2, '0');
const utcStamp = (secs) => {
  const d = new Date(secs * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

// Live categories in playlist order. Portal genre ids are kept where numeric
// (clients parse category ids as integers); others get a synthetic id.
function liveCatalog(channels, groups) {
  const idByName = new Map(groups.map((g) => [g.name, String(g.id)]));
  const categories = [];
  const categoryOf = new Map(); // group name → category id
  const streams = groupChannels(channels, groups).map(({ ch, group }, i) => {
    if (!categoryOf.has(group)) {
      const portalId = idByName.get(group);
      const id = portalId && /^\d+$/.test(portalId) ? portalId : String(SYNTHETIC_CATEGORY_BASE + categories.length);
      categoryOf.set(group, id);
      categories.push({ category_id: id, category_name: group, parent_id: 0 });
    }
    return { ch, num: i + 1, categoryId: categoryOf.get(group) };
  });
  return { categories, streams };
}

module.exports = function xtreamModule(appState, { proxyRouter, m3uRouter, xmltvRouter, logoManager = null, idStore }) {
  const router = express.Router();

  // Titles seen in a listing, by id — for get_vod_info, the movie's cmd at play
  // time, and a show's episode list when the portal has no seasons.
  const titles = new Map();
  const seriesInfoCache = new Map(); // seriesId → { value, ts }

  const baseOf = (req) => `${req.protocol}://${req.get('host')}`;
  const showAdult = () => appState.getShowAdult?.() === true;
  const hiddenLanguages = () => appState.profilesManager?.activeDisabledLanguages?.() ?? new Set();

  const logoFor = (ch) => (logoManager ? logoManager.resolveOverride(ch.name) : '')
    || ch.iconPath
    || (logoManager ? logoManager.resolveDbLogo(ch.name) : '')
    || '';

  const posterFor = (req, uri) => {
    const rel = uri ? appState.vodManager?.resolveScreenshot(uri) : null;
    return rel ? baseOf(req) + rel : '';
  };

  // ── Account ────────────────────────────────────────────────────────────────

  function accountInfo(req) {
    const now = Math.floor(Date.now() / 1000);
    // Players rebuild stream URLs from these, so report the address they used.
    const port = String(req.get('host')?.split(':')[1] || (req.protocol === 'https' ? 443 : 80));
    return {
      user_info: {
        username: String(req.query.username ?? ''),
        password: String(req.query.password ?? ''),
        message: '',
        auth: 1,
        status: 'Active',
        exp_date: null,
        is_trial: '0',
        active_cons: String(appState.activeStreams || 0),
        created_at: String(now),
        max_connections: '1',
        allowed_output_formats: ['m3u8', 'ts'],
      },
      server_info: {
        url: req.hostname,
        port,
        https_port: port,
        server_protocol: req.protocol,
        rtmp_port: '0',
        timezone: 'UTC',
        timestamp_now: now,
        time_now: utcStamp(now),
      },
    };
  }

  // ── Live ───────────────────────────────────────────────────────────────────

  function liveData(req) {
    const { channelManager } = appState;
    const keep = appState.getExportFilter?.().keep ?? (() => true);
    const shown = channelManager.getChannels().filter(keep);
    const catalog = liveCatalog(shown, channelManager.getGroups());
    if (req.query.category_id) {
      catalog.streams = catalog.streams.filter((s) => s.categoryId === String(req.query.category_id));
    }
    return catalog;
  }

  const liveStream = ({ ch, num, categoryId }) => ({
    num,
    name: ch.name,
    stream_type: 'live',
    stream_id: asNumber(ch.uniqueId),
    stream_icon: logoFor(ch),
    epg_channel_id: String(ch.uniqueId),
    added: '0',
    is_adult: '0',
    category_id: categoryId,
    category_ids: [asNumber(categoryId)],
    custom_sid: '',
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0,
  });

  // ── VOD / series categories ────────────────────────────────────────────────

  async function visibleCategories(type) {
    const hidden = hiddenLanguages();
    const adult = showAdult();
    const all = await appState.vodManager.getCategories(type);
    return all.filter((c) =>
      String(c.id) !== ALL_CATEGORIES_ID &&
      !isLanguageDisabled(c.title, hidden) &&
      (adult || !isAdult(c.title)));
  }

  // Series live in the portal's "series" section when it has one; otherwise
  // shows are mixed into the movie categories, flagged is_series.
  async function seriesSource() {
    const own = await visibleCategories('series');
    return own.length ? { type: 'series', categories: own, all: true } : { type: 'vod', categories: await visibleCategories('vod'), all: false };
  }

  const categoryRows = (cats) => cats.map((c) => ({ category_id: String(c.id), category_name: c.title, parent_id: 0 }));

  // Titles of one category, or of every visible category when none is given.
  async function listTitles(type, categories, categoryId) {
    const wanted = categoryId
      ? categories.filter((c) => String(c.id) === String(categoryId))
      : categories;
    const out = [];
    for (const c of wanted) {
      const items = await appState.vodManager.getAllItems(type, c.id);
      for (const item of items) {
        titles.set(String(item.id), item);
        out.push({ item, categoryId: String(c.id) });
      }
    }
    return out;
  }

  const movieRow = (req) => ({ item, categoryId }, i) => ({
    num: i + 1,
    name: item.name,
    title: item.name,
    year: item.year,
    stream_type: 'movie',
    stream_id: asNumber(item.id),
    stream_icon: posterFor(req, item.screenshotUri),
    rating: '',
    rating_5based: 0,
    added: toUnix(item.added),
    is_adult: '0',
    category_id: categoryId,
    category_ids: [asNumber(categoryId)],
    container_extension: CONTAINER,
    custom_sid: '',
    direct_source: '',
    plot: item.description,
  });

  const seriesRow = (req) => ({ item, categoryId }, i) => ({
    num: i + 1,
    name: item.name,
    title: item.name,
    year: item.year,
    series_id: asNumber(item.id),
    cover: posterFor(req, item.screenshotUri),
    plot: item.description,
    cast: item.actors,
    director: item.director,
    genre: '',
    releaseDate: item.year,
    release_date: item.year,
    last_modified: toUnix(item.added),
    rating: '0',
    rating_5based: 0,
    backdrop_path: [],
    youtube_trailer: '',
    episode_run_time: '',
    category_id: categoryId,
    category_ids: [asNumber(categoryId)],
  });

  function vodInfo(req, vodId) {
    const item = titles.get(String(vodId));
    const cover = posterFor(req, item?.screenshotUri);
    const secs = (item?.durationMin || 0) * 60;
    return {
      info: {
        name: item?.name || '',
        o_name: item?.name || '',
        movie_image: cover,
        cover_big: cover,
        plot: item?.description || '',
        description: item?.description || '',
        cast: item?.actors || '',
        actors: item?.actors || '',
        director: item?.director || '',
        genre: '',
        country: item?.country || '',
        releasedate: item?.year || '',
        duration_secs: secs,
        duration: `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:00`,
        rating: '',
      },
      movie_data: {
        stream_id: asNumber(vodId),
        name: item?.name || '',
        added: toUnix(item?.added),
        category_id: item?.categoryId || '',
        container_extension: CONTAINER,
        custom_sid: '',
        direct_source: '',
      },
    };
  }

  // Seasons and episodes for a show: one portal request for the seasons, then
  // one per season. Cached, since players reopen a show often.
  async function seriesInfo(req, seriesId) {
    const hit = seriesInfoCache.get(String(seriesId));
    if (hit && Date.now() - hit.ts < SERIES_INFO_TTL_MS) return hit.value;

    const { vodManager } = appState;
    const show = titles.get(String(seriesId));
    const seasons = [];
    const episodes = {};
    const episodeRow = (ref, num, title, image, seasonNo) => ({
      id: String(idStore.idFor(ref)),
      episode_num: num,
      title,
      container_extension: CONTAINER,
      info: { movie_image: image, plot: '', duration_secs: 0 },
      custom_sid: '',
      added: '',
      season: seasonNo,
      direct_source: '',
    });

    const portalSeasons = await vodManager.getSeasons(seriesId);
    for (const [i, s] of portalSeasons.entries()) {
      const seasonNo = parseInt(s.seasonNumber, 10) || i + 1;
      const cover = posterFor(req, s.screenshotUri);
      const eps = await vodManager.getEpisodes(seriesId, s.id);
      episodes[seasonNo] = eps.map((e, j) => {
        const num = parseInt(e.seriesNumber, 10) || j + 1;
        return episodeRow(
          { showId: seriesId, seasonId: s.id, episodeId: e.episodeId, series: num },
          num, e.name, posterFor(req, e.screenshotUri) || cover, seasonNo);
      });
      seasons.push({ id: seasonNo, season_number: seasonNo, name: s.name, episode_count: eps.length, cover, cover_big: cover, air_date: '' });
    }

    // Older portals list a show's episodes as plain numbers on the title itself.
    if (!seasons.length && show?.episodes?.length) {
      const cover = posterFor(req, show.screenshotUri);
      episodes[1] = show.episodes.map((n) => episodeRow(
        { showId: seriesId, series: Number(n) }, Number(n), `Episode ${n}`, cover, 1));
      seasons.push({ id: 1, season_number: 1, name: 'Season 1', episode_count: show.episodes.length, cover, cover_big: cover, air_date: '' });
    }

    const value = {
      seasons,
      info: {
        name: show?.name || '',
        cover: posterFor(req, show?.screenshotUri),
        plot: show?.description || '',
        cast: show?.actors || '',
        director: show?.director || '',
        genre: '',
        releaseDate: show?.year || '',
        rating: '0',
        category_id: show?.categoryId || '',
        backdrop_path: [],
      },
      episodes,
    };
    seriesInfoCache.set(String(seriesId), { value, ts: Date.now() });
    return value;
  }

  // ── EPG ────────────────────────────────────────────────────────────────────

  async function shortEpg(streamId, limit, all) {
    const { channelManager, guideManager } = appState;
    const ch = channelManager.getChannel(streamId);
    if (!ch || !guideManager) return [];
    try { await guideManager.loadGuide(24); } catch { return []; }
    const now = Math.floor(Date.now() / 1000);
    const events = guideManager.getChannelEvents(ch.channelId).filter((e) => all || e.endTime > now);
    return events.slice(0, all ? events.length : limit).map((e, i) => ({
      id: String(i + 1),
      epg_id: String(ch.uniqueId),
      title: b64(e.title),
      lang: '',
      start: utcStamp(e.startTime),
      end: utcStamp(e.endTime),
      description: b64(e.description),
      channel_id: String(ch.uniqueId),
      start_timestamp: String(e.startTime),
      stop_timestamp: String(e.endTime),
      now_playing: e.startTime <= now && e.endTime > now ? 1 : 0,
      has_archive: 0,
    }));
  }

  // ── player_api.php ─────────────────────────────────────────────────────────

  router.all('/player_api.php', async (req, res) => {
    const action = String(req.query.action || req.body?.action || '');
    if (!action) return res.json(accountInfo(req));

    if (!appState.channelManager || !appState.vodManager) {
      return res.status(503).json({ error: 'Not connected to portal — connect first via the web UI' });
    }

    try {
      switch (action) {
        case 'get_live_categories':
          return res.json(liveData(req).categories);
        case 'get_live_streams':
          return res.json(liveData(req).streams.map(liveStream));

        case 'get_vod_categories':
          return res.json(categoryRows(await visibleCategories('vod')));
        case 'get_vod_streams': {
          const rows = await listTitles('vod', await visibleCategories('vod'), req.query.category_id);
          return res.json(rows.filter(({ item }) => !item.isSeries).map(movieRow(req)));
        }
        case 'get_vod_info':
          return res.json(vodInfo(req, req.query.vod_id));

        case 'get_series_categories':
          return res.json(categoryRows((await seriesSource()).categories));
        case 'get_series': {
          const src = await seriesSource();
          const rows = await listTitles(src.type, src.categories, req.query.category_id);
          return res.json(rows.filter(({ item }) => src.all || item.isSeries).map(seriesRow(req)));
        }
        case 'get_series_info':
          if (!req.query.series_id) return res.status(400).json({ error: 'series_id is required' });
          return res.json(await seriesInfo(req, req.query.series_id));

        case 'get_short_epg':
          return res.json({ epg_listings: await shortEpg(req.query.stream_id, parseInt(req.query.limit, 10) || 4, false) });
        case 'get_simple_data_table':
          return res.json({ epg_listings: await shortEpg(req.query.stream_id, 0, true) });

        default:
          return res.status(400).json({ error: `unknown action: ${action}` });
      }
    } catch (e) {
      log.error(TAG, `${action} failed: ${e.message}`);
      return res.status(502).json({ error: e.message });
    } finally {
      appState.touchActivity?.();
    }
  });

  // ── Playlists ──────────────────────────────────────────────────────────────

  // Hands the request to another router under a new path, keeping the query.
  const forward = (target, path) => (req, res, next) => {
    const q = req.url.indexOf('?');
    req.url = path + (q === -1 ? '' : req.url.slice(q));
    target(req, res, next);
  };

  if (m3uRouter)   router.get('/get.php',   forward(m3uRouter, '/'));
  if (xmltvRouter) router.get('/xmltv.php', forward(xmltvRouter, '/'));

  // ── Streams ────────────────────────────────────────────────────────────────

  const STREAM_FILE = /^(-?\d+)(?:\.\w+)?$/;

  function playLive(req, res, next) {
    const m = STREAM_FILE.exec(req.params.file);
    if (!m) return next();
    forward(proxyRouter, `/stream/${m[1]}`)(req, res, next);
  }

  router.get('/live/:user/:pass/:file', playLive);

  router.get('/movie/:user/:pass/:file', (req, res, next) => {
    const m = STREAM_FILE.exec(req.params.file);
    if (!m) return next();
    const p = new URLSearchParams({ videoId: m[1] });
    const cmd = titles.get(m[1])?.cmd;
    if (cmd) p.set('cmd', cmd);
    req.url = `/vod/stream?${p}`;
    proxyRouter(req, res, next);
  });

  router.get('/series/:user/:pass/:file', (req, res, next) => {
    const m = STREAM_FILE.exec(req.params.file);
    if (!m) return next();
    const ep = idStore.get(m[1]);
    if (!ep) return res.status(404).send('Unknown episode — reopen the show to refresh its episode list');
    const p = new URLSearchParams({ videoId: ep.showId });
    if (ep.series)    p.set('series', String(ep.series));
    if (ep.seasonId)  p.set('seasonId', ep.seasonId);
    if (ep.episodeId) p.set('episodeId', ep.episodeId);
    req.url = `/vod/stream?${p}`;
    proxyRouter(req, res, next);
  });

  // Some players drop the /live prefix: /<user>/<pass>/<streamId>.ts
  router.get('/:user/:pass/:file', playLive);

  return router;
};

module.exports.liveCatalog = liveCatalog;
