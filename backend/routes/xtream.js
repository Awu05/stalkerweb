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
// The catalog (filters, listings, caches, playback paths) is shared with the
// Stremio addon — see lib/catalog.js. This module only speaks Xtream.

'use strict';

const express = require('express');
const log = require('../logger');
const { createCatalog } = require('../lib/catalog');
const TAG = 'xtream';

const CONTAINER = 'mp4';

const asNumber = (id) => (/^-?\d+$/.test(String(id)) ? Number(id) : String(id));
const toUnix   = (date) => { const t = Date.parse(date); return Number.isFinite(t) ? String(Math.floor(t / 1000)) : '0'; };
const pad      = (n) => String(n).padStart(2, '0');
const utcStamp = (secs) => {
  const d = new Date(secs * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

module.exports = function xtreamModule(appState, { proxyRouter, m3uRouter, xmltvRouter, logoManager = null, idStore, catalog = null, allTitlesWaitMs }) {
  const router = express.Router();
  const cat = catalog ?? createCatalog(appState, { logoManager, idStore, allTitlesWaitMs });

  const baseOf = (req) => `${req.protocol}://${req.get('host')}`;

  // ── Account ────────────────────────────────────────────────────────────────

  function accountInfo(req) {
    const now = Math.floor(Date.now() / 1000);
    // Players rebuild stream URLs from these, so report the address they used.
    // Parsed as a URL so an IPv6 host ([::1]:8983) keeps its port.
    let port = '';
    try { port = new URL(baseOf(req)).port; } catch { /* malformed Host — use the default */ }
    port = port || (req.protocol === 'https' ? '443' : '80');
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

  // ── Rows ───────────────────────────────────────────────────────────────────

  const categoryRows = (cats) => cats.map((c) => ({ category_id: String(c.id), category_name: c.title ?? c.name, parent_id: 0 }));

  const liveStream = ({ ch, num, categoryId }) => ({
    num,
    name: ch.name,
    stream_type: 'live',
    stream_id: asNumber(ch.uniqueId),
    stream_icon: cat.logoFor(ch),
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

  const movieRow = (req) => ({ item, categoryId }, i) => ({
    num: i + 1,
    name: item.name,
    title: item.name,
    year: item.year,
    stream_type: 'movie',
    stream_id: asNumber(item.id),
    stream_icon: cat.posterFor(baseOf(req), item.screenshotUri),
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
    cover: cat.posterFor(baseOf(req), item.screenshotUri),
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
    const item = cat.findMovie(vodId);
    const cover = cat.posterFor(baseOf(req), item?.screenshotUri);
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

  async function seriesInfo(req, seriesId) {
    const base = baseOf(req);
    const show = cat.findShow(seriesId);
    const seasons = [];
    const episodes = {};
    for (const s of await cat.seasonsOf(seriesId)) {
      const cover = cat.posterFor(base, s.imageUri);
      episodes[s.number] = s.episodes.map((e) => ({
        id: String(e.id),
        episode_num: e.number,
        title: e.title,
        container_extension: CONTAINER,
        info: { movie_image: cat.posterFor(base, e.imageUri) || cover, plot: '', duration_secs: 0 },
        custom_sid: '',
        added: '',
        season: s.number,
        direct_source: '',
      }));
      seasons.push({ id: s.number, season_number: s.number, name: s.name, episode_count: s.episodes.length, cover, cover_big: cover, air_date: '' });
    }

    return {
      seasons,
      info: {
        name: show?.name || '',
        cover: cat.posterFor(base, show?.screenshotUri),
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
          return res.json(categoryRows(cat.liveData().categories));
        case 'get_live_streams':
          return res.json(cat.liveData(req.query.category_id).streams.map(liveStream));

        case 'get_vod_categories':
          return res.json(categoryRows(await cat.visibleCategories('vod')));
        case 'get_vod_streams':
          return res.json((await cat.listMovies(req.query.category_id)).map(movieRow(req)));
        case 'get_vod_info':
          return res.json(vodInfo(req, req.query.vod_id));

        case 'get_series_categories':
          return res.json(categoryRows((await cat.seriesSource()).categories));
        case 'get_series':
          return res.json((await cat.listShows(req.query.category_id)).map(seriesRow(req)));
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

  // Only the /live/ form. The bare /<user>/<pass>/<id> form some players
  // accept is left out: as a catch-all it turned any stray 3-part URL ending
  // in a number into a stream start, and a new create_link ends the stream
  // already playing.
  router.get('/live/:user/:pass/:file', (req, res, next) => {
    const m = STREAM_FILE.exec(req.params.file);
    if (!m) return next();
    forward(proxyRouter, cat.liveProxyPath(m[1]))(req, res, next);
  });

  router.get('/movie/:user/:pass/:file', (req, res, next) => {
    const m = STREAM_FILE.exec(req.params.file);
    if (!m) return next();
    req.url = cat.movieProxyPath(m[1]);
    proxyRouter(req, res, next);
  });

  router.get('/series/:user/:pass/:file', (req, res, next) => {
    const m = STREAM_FILE.exec(req.params.file);
    if (!m) return next();
    const ep = cat.episodeProxyPath(m[1]);
    if (ep.error) return res.status(404).send(ep.error);
    req.url = ep.path;
    proxyRouter(req, res, next);
  });

  return router;
};
