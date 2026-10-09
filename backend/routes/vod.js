// routes/vod.js
// GET    /api/vod/categories?type=vod|series
// GET    /api/vod/items?type=vod|series&category=X&page=1&search=&fav=0
// GET    /api/vod/seasons/:movieId
// GET    /api/vod/stream?videoId=X&cmd=<encoded>&series=0
// GET    /api/vod/progress        — list all "Continue Watching" entries
// PUT    /api/vod/progress        — upsert an entry
// DELETE /api/vod/progress/:key   — remove an entry

'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const router  = express.Router();
const sessionMiddleware = require('../middleware/session');
const { visibleVodCategories } = require('../lib/vodCategoryFilter');

const log = require('../logger');
const TAG = 'vod';

const VOD_PROGRESS_MAX = 20;

class VodProgressStore {
  constructor(dataDir) {
    this._file = path.join(dataDir, 'vod-progress.json');
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  save(list) {
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log.error(TAG, `vod-progress save failed: ${e.message}`);
    }
  }
}

module.exports = function vodRoutes(appState, config) {
  const progressStore = config?.dataDir ? new VodProgressStore(config.dataDir) : null;
  const guard = sessionMiddleware(appState);

  // GET /api/vod/categories?type=vod|series[&all=1]
  //
  // Filtered by the current viewer's hidden movie & series categories (and an
  // old hidden-languages list), dropping the portal's "All" pseudo-category
  // whenever anything is hidden (lib/vodCategoryFilter.js). Done here rather
  // than in each client, so every client gets the same answer. ?all=1 lists
  // every category, for the Settings list where they are hidden.
  router.get('/categories', guard, async (req, res) => {
    const { vodManager } = appState;
    const type = req.query.type === 'series' ? 'series' : 'vod';
    const categories = await vodManager.getCategories(type);
    if (req.query.all === '1') return res.json({ categories });
    res.json({
      categories: visibleVodCategories(categories, {
        hiddenCategories: appState.getHiddenVodCategories?.() ?? new Set(),
        hiddenLanguages: appState.getHiddenLanguages?.() ?? new Set(),
      }),
    });
  });

  // GET /api/vod/items?type=vod|series&category=X&page=1&search=&fav=0
  router.get('/items', guard, async (req, res) => {
    const { vodManager } = appState;
    const { category, search = '', fav = '0', page = '1' } = req.query;
    const type = req.query.type === 'series' ? 'series' : 'vod';

    if (!category) return res.status(400).json({ error: 'category is required' });

    const result = await vodManager.getItems({
      type,
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

  // ── Continue Watching progress (no session guard — persists across disconnects) ──
  // The store itself is one shared file (not per-portal), but each entry is
  // tagged with the portal it was saved under so switching portals doesn't
  // surface (or let a client accidentally merge in) another portal's videoIds
  // — which are meaningless outside the catalog they came from.

  // GET /api/vod/progress — scoped to the currently connected portal, if any.
  // While disconnected there's no "current portal" to filter by, so this
  // falls back to the full list (best-effort, matches prior behavior).
  router.get('/progress', (req, res) => {
    if (!progressStore) return res.json([]);
    const list = progressStore.load();
    const portal = appState.client?.getBasePath?.();
    if (!portal) return res.json(list);
    res.json(list.filter(e => !e.portal || e.portal === portal));
  });

  // PUT /api/vod/progress — upsert a single entry { key, ... }
  router.put('/progress', (req, res) => {
    if (!progressStore) return res.json({ ok: true });
    const entry = req.body;
    if (!entry?.key) return res.status(400).json({ error: 'key is required' });
    const portal = appState.client?.getBasePath?.() || null;
    const list = progressStore.load().filter(e => e.key !== entry.key);
    const next = [{ ...entry, portal, updatedAt: entry.updatedAt ?? Date.now() }, ...list].slice(0, VOD_PROGRESS_MAX);
    progressStore.save(next);
    res.json({ ok: true });
  });

  // DELETE /api/vod/progress/:key
  router.delete('/progress/:key', (req, res) => {
    if (!progressStore) return res.json({ ok: true });
    const key = req.params.key;
    progressStore.save(progressStore.load().filter(e => e.key !== key));
    res.json({ ok: true });
  });

  return router;
};
