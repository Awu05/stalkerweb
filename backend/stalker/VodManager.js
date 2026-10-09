'use strict';

// VodManager.js
// Handles VOD and Series content: categories, item listings, seasons, stream resolution.
// Mirrors the logic in plugin.video.stalkervod (api.py) ported to Node.js.

const log = require('../logger');
const TAG = 'VodManager';

// Seasons and episodes from the first, whatever order the portal lists them in
// (many list the newest first): by number, then — for any without one — by
// name, counting digits as numbers ("Episode 3" before "Episode 11").
function firstToLast(numberField) {
  const num = (x) => { const n = parseInt(x[numberField], 10); return Number.isFinite(n) ? n : null; };
  return (a, b) => {
    const na = num(a), nb = num(b);
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  };
}

// Resolved VOD links carry a long-lived token (valid for the whole movie), but
// resolution is slow/fragile on some portals (multiple round-trips, occasional
// timeouts). Cache the resolved URL briefly so player reloads/seeks/recovery
// don't re-resolve — which previously fell into the nothing_to_play fallback.
const VOD_LINK_TTL_MS = 5 * 60 * 1000;
const CATEGORY_TTL_MS = 30 * 60 * 1000;
const EMPTY_CATEGORY_TTL_MS = 60 * 1000;

// Whole-category listings (getAllItems) for clients that ask for a category's
// full contents at once, like the Xtream API. A category is one portal page
// per ~14 titles, read one at a time with a pause between pages so a big
// catalog never bursts into the portal's rate limit, then kept for an hour.
const LISTING_TTL_MS      = 60 * 60 * 1000;
const LISTING_MAX_PAGES   = 150;   // ~2,100 titles per category
const LISTING_PAGE_GAP_MS = 150;
const PARTIAL_LISTING_TTL_MS = 2 * 60 * 1000;

class VodManager {
  constructor(client, { pageGapMs = LISTING_PAGE_GAP_MS } = {}) {
    this.client = client;
    this._pageGapMs = pageGapMs;
    this._linkCache = new Map(); // `${videoId}:${series}` → { url, ts }
    this._categoryCache = new Map(); // type → { value, ts } | { pending }
    this._listingCache = new Map();  // `${type}:${categoryId}` → { value, ts } | { pending }
    this._pageCache = new Map();     // `${type}:${categoryId}:${page}` → { value, ts } | { pending }
    this._walks = new Map();         // `${type}:${categoryId}` → { items, total } while a listing is read
  }

  // Returns the cached value for `key`, or runs `fetch` once for every caller
  // waiting on it. `ttlFor(value)` says how long a result is kept, so a doubtful
  // one (empty, partial) can expire sooner. A failed fetch is not cached.
  _cached(cache, key, ttlFor, fetch) {
    const hit = cache.get(key);
    if (hit && (hit.pending || Date.now() - hit.ts < hit.ttl)) {
      return hit.pending || Promise.resolve(hit.value);
    }
    const pending = fetch().then(
      (value) => { cache.set(key, { value, ts: Date.now(), ttl: ttlFor(value) }); return value; },
      (e)     => { cache.delete(key); throw e; },
    );
    cache.set(key, { pending });
    return pending;
  }

  // The cached value for `key` if it is fresh, else undefined. Never fetches.
  _peek(cache, key) {
    const hit = cache.get(key);
    return hit && !hit.pending && Date.now() - hit.ts < hit.ttl ? hit.value : undefined;
  }

  // ── Categories ─────────────────────────────────────────────────────────────

  // Cached: the category list barely changes, yet /api/vod/categories and
  // /api/channels/languages both ask for it on every request. Concurrent
  // callers share one in-flight portal request.
  getCategories(type = 'vod') {
    // An empty list is usually a bad portal response (an error object instead
    // of the list), so it is kept only briefly rather than the full TTL.
    return this._cached(this._categoryCache, type,
      (cats) => (cats.length ? CATEGORY_TTL_MS : EMPTY_CATEGORY_TTL_MS),
      () => this._fetchCategories(type));
  }

  async _fetchCategories(type) {
    const r = await this.client._stalkerCall({ type, action: 'get_categories' });
    const cats = r?.js;
    if (!Array.isArray(cats)) return [];
    return cats
      .filter(c => c.id && c.title)
      .map(c => ({ id: String(c.id), title: String(c.title), alias: c.alias || '' }));
  }

  // ── Item listings ──────────────────────────────────────────────────────────

  // Fetches one batch of VOD/series items for a category. Each batch is
  // maxPages consecutive portal pages (mirrors the Kodi plugin's
  // max_page_limit, default 3), and `page` / `totalPages` count BATCHES: page 2
  // is portal pages 4–6. Clients page with page+1 until page === totalPages;
  // when `page` meant the first portal page instead, each "next page" re-read
  // two pages it already had — duplicate titles and wasted portal requests.
  // `sort` is the portal's own order: 'added' (newest first) or 'name' (A–Z).
  async getItems({ type = 'vod', categoryId, page = 1, search = '', fav = 0, maxPages = 3, sort = 'added' } = {}) {
    const firstPortalPage = (page - 1) * maxPages + 1;
    const params = {
      type,
      action: 'get_ordered_list',
      category: String(categoryId),
      sortby:   sort === 'name' ? 'name' : 'added',
      fav:      String(fav),
      p:        String(firstPortalPage),
    };
    if (search) params.search = search;

    const r   = await this.client._stalkerCall(params);
    const js  = r?.js || {};
    let items = Array.isArray(js.data) ? js.data : [];

    const totalItems   = parseInt(js.total_items   || '0', 10) || items.length;
    const maxPageItems = parseInt(js.max_page_items || '14', 10) || 14;
    const portalPages  = Math.max(1, Math.ceil(totalItems / maxPageItems));
    const totalPages   = Math.max(1, Math.ceil(portalPages / maxPages));

    // Fetch the rest of this batch (same pattern as the Kodi plugin)
    for (let p2 = firstPortalPage + 1; p2 <= Math.min(firstPortalPage + maxPages - 1, portalPages); p2++) {
      try {
        const r2 = await this.client._stalkerCall({ ...params, p: String(p2) });
        items = items.concat(Array.isArray(r2?.js?.data) ? r2.js.data : []);
      } catch (e) {
        log.warn(TAG, `multi-page fetch: page ${p2} failed — ${e.message}`);
        break;
      }
    }

    return {
      items:      items.map(i => this._normalizeItem(i)),
      totalItems,
      totalPages,
      page,
    };
  }

  // Every title in a category, cached (see LISTING_TTL_MS). Pages are read in
  // order with a pause between them; a page that fails after the first ends
  // the walk with what was read so far, and that partial list is kept only
  // briefly so the next request tries again.
  getAllItems(type, categoryId) {
    const key = `${type}:${categoryId}`;
    return this._cached(this._listingCache, key,
      (r) => (r.complete ? LISTING_TTL_MS : PARTIAL_LISTING_TTL_MS),
      () => this._fetchAllItems(type, String(categoryId)),
    ).then((r) => r.items);
  }

  /** A category's titles if a fresh listing is cached, else undefined. */
  peekAllItems(type, categoryId) {
    return this._peek(this._listingCache, `${type}:${categoryId}`)?.items;
  }

  /** A fresh cached listing as { items, complete }, else undefined. */
  peekListing(type, categoryId) {
    return this._peek(this._listingCache, `${type}:${categoryId}`);
  }

  /**
   * How far the reading of a category's listing has got: { items (read so
   * far, in order), total } while getAllItems is reading it, else null — so a
   * client can show titles as they arrive instead of waiting for all of them.
   */
  listingProgress(type, categoryId) {
    return this._walks.get(`${type}:${categoryId}`) ?? null;
  }

  // One portal page of a category: { items, total, perPage }. Cached, and
  // shared by getAllItems and getRange so neither reads a page the other has.
  _getPage(type, categoryId, p) {
    return this._cached(this._pageCache, `${type}:${categoryId}:${p}`, () => LISTING_TTL_MS, async () => {
      const r = await this.client._stalkerCall({
        type, action: 'get_ordered_list', category: categoryId, sortby: 'added', fav: '0', p: String(p),
      });
      const js = r?.js || {};
      const data = Array.isArray(js.data) ? js.data : [];
      const items = data.map((raw) => {
        const item = this._normalizeItem(raw);
        if (!item.categoryId) item.categoryId = categoryId;
        return item;
      });
      return {
        items,
        total:   parseInt(js.total_items || '0', 10) || data.length,
        perPage: parseInt(js.max_page_items || '14', 10) || 14,
      };
    });
  }

  // Reads page `p`, pausing first when it isn't cached and isn't the first
  // read of a walk — so a walk never bursts into the portal's rate limit.
  async _readPage(type, categoryId, p, pause) {
    if (pause && this._pageGapMs && this._peek(this._pageCache, `${type}:${categoryId}:${p}`) === undefined) {
      await new Promise((r) => setTimeout(r, this._pageGapMs));
    }
    return this._getPage(type, categoryId, p);
  }

  async _fetchAllItems(type, categoryId) {
    const key = `${type}:${categoryId}`;
    const walk = { items: [], total: 0 };
    this._walks.set(key, walk);
    try {
      return await this._walkAllItems(type, categoryId, walk);
    } finally {
      this._walks.delete(key);
    }
  }

  async _walkAllItems(type, categoryId, walk) {
    const items = walk.items;
    let complete = true;
    const first = await this._getPage(type, categoryId, 1);
    walk.total = first.total;
    const pages = Math.max(1, Math.ceil(first.total / first.perPage));
    if (pages > LISTING_MAX_PAGES) {
      log.warn(TAG, `listing ${type}/${categoryId}: ${first.total} titles — reading the newest ${LISTING_MAX_PAGES * first.perPage}`);
    }
    for (let p = 1; p <= Math.min(pages, LISTING_MAX_PAGES); p++) {
      let page;
      try {
        page = p === 1 ? first : await this._readPage(type, categoryId, p, true);
      } catch (e) {
        log.warn(TAG, `listing ${type}/${categoryId}: page ${p} failed (${e.message}) — keeping ${items.length} titles for now`);
        complete = false;
        break;
      }
      if (!page.items.length) break;
      items.push(...page.items);
    }
    log.info(TAG, `listing ${type}/${categoryId}: ${items.length} titles`);
    return { items, complete };
  }

  /**
   * Titles `start`…`start + count - 1` of a category, reading only the portal
   * pages that cover them — a client paging through a big category gets its
   * first screen without waiting for the whole category. A page that fails
   * after the first ends the range early.
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async getRange(type, categoryId, start, count) {
    const cat = String(categoryId);
    const first = await this._getPage(type, cat, 1);
    const { total, perPage } = first;
    const end = Math.min(total, start + count, LISTING_MAX_PAGES * perPage);
    if (start >= end) return { items: [], total };
    const firstPage = Math.floor(start / perPage) + 1;
    const lastPage  = Math.floor((end - 1) / perPage) + 1;
    const items = [];
    for (let p = firstPage; p <= lastPage; p++) {
      try {
        const page = p === 1 ? first : await this._readPage(type, cat, p, p > firstPage);
        if (!page.items.length) break;
        items.push(...page.items);
      } catch (e) {
        log.warn(TAG, `range ${type}/${cat}: page ${p} failed (${e.message})`);
        break;
      }
    }
    const offset = start - (firstPage - 1) * perPage;
    return { items: items.slice(offset, offset + (end - start)), total };
  }

  // ── Seasons / Episodes (TV-show drill-down) ─────────────────────────────────
  //
  // A TV show needs a 3-level walk, all via get_ordered_list?type=vod (captured
  // from STBemu):
  //   show:    movie_id=<showId> season_id=0  episode_id=0   → seasons
  //   season:  movie_id=<showId> season_id=<s> episode_id=0  → episodes
  //   episode: movie_id=<showId> season_id=<s> episode_id=<e>→ the file record
  // create_link then uses /media/file_<fileId>.mpg with series=<series_number>.

  async getSeasons(showId) {
    const r = await this.client._stalkerCall({
      type:       'vod',
      action:     'get_ordered_list',
      movie_id:   String(showId),
      season_id:  '0',
      episode_id: '0',
      sortby:     'added',
      p:          '1',
    });
    const data = Array.isArray(r?.js?.data) ? r.js.data : [];
    return data.map(s => ({
      id:            String(s.id),
      name:          s.season_name || s.name || s.o_name || `Season ${s.season_number || s.id}`,
      seasonNumber:  s.season_number != null ? String(s.season_number) : '',
      screenshotUri: s.screenshot_uri || s.screenshot || null,
    })).sort(firstToLast('seasonNumber'));
  }

  async getEpisodes(showId, seasonId) {
    const r = await this.client._stalkerCall({
      type:       'vod',
      action:     'get_ordered_list',
      movie_id:   String(showId),
      season_id:  String(seasonId),
      episode_id: '0',
      sortby:     'added',
      p:          '1',
    });
    const data = Array.isArray(r?.js?.data) ? r.js.data : [];
    return data.map(e => ({
      episodeId:     String(e.id),
      seriesNumber:  e.series_number != null ? String(e.series_number) : '',
      name:          e.series_name || e.name || `Episode ${e.series_number || e.id}`,
      screenshotUri: e.screenshot_uri || e.screenshot || null,
    })).sort(firstToLast('seriesNumber'));
  }

  // Resolve a specific episode's concrete file record (id + direct url) via the
  // episode_id drill-down. This file id is what create_link needs.
  async _getEpisodeFile(showId, seasonId, episodeId) {
    try {
      const r = await this.client._stalkerCall({
        type:       'vod',
        action:     'get_ordered_list',
        movie_id:   String(showId),
        season_id:  String(seasonId || '0'),
        episode_id: String(episodeId),
        sortby:     'added',
        p:          '1',
      });
      const data = Array.isArray(r?.js?.data) ? r.js.data : [];
      if (!data.length) return null;
      const entry  = data[0];
      const fileId = entry?.id != null ? String(entry.id).trim() : '';
      log.debug(TAG, `episode_id=${episodeId} → fileId=${fileId} protocol=${entry?.protocol || ''}`);
      return {
        fileId,
        url: this._extractUrl(entry?.url) || this._extractUrl(entry?.cmd),
      };
    } catch (e) {
      log.warn(TAG, `episode file lookup (episode_id=${episodeId}) failed: ${e.message}`);
      return null;
    }
  }

  // ── File record lookup ─────────────────────────────────────────────────────

  // Fetch a movie's concrete file record the way STBemu does before playback:
  // get_ordered_list with movie_id set returns js.data[] of files. Each file's
  // `id` (distinct from `video_id`) is what create_link needs as
  // /media/file_<id>.mpg; the row often also carries a direct `url`. For a
  // series, pick the entry matching the requested episode.
  async _getMovieFile(videoId, seriesNum = 0) {
    try {
      const r = await this.client._stalkerCall({
        type:       'vod',
        action:     'get_ordered_list',
        movie_id:   String(videoId),
        season_id:  '0',
        episode_id: '0',
        sortby:     'added',
        p:          '1',
      });
      const data = Array.isArray(r?.js?.data) ? r.js.data : [];
      if (!data.length) return null;

      let entry = data[0];
      if (seriesNum > 0) {
        const match = data.find(d =>
          Number(d.series_number ?? d.episode ?? d.episode_number) === seriesNum);
        if (match) entry = match;
      }

      const fileId = entry?.id != null ? String(entry.id).trim() : '';
      log.debug(TAG, `movie_id=${videoId} → fileId=${fileId} protocol=${entry?.protocol || ''}`);
      return {
        fileId,
        url: this._extractUrl(entry?.url) || this._extractUrl(entry?.cmd),
      };
    } catch (e) {
      log.warn(TAG, `movie file lookup (get_ordered_list movie_id) failed: ${e.message}`);
      return null;
    }
  }

  // ── Play-event log ─────────────────────────────────────────────────────────

  // Fire-and-forget play notification, mirroring STBemu's call right after
  // create_link: `type=stb&action=log&real_action=play&content_id=<fileId>
  // &tmp_type=2&id=<videoId>&cmd=<url>`. Not required for playback — it feeds
  // the portal's watch history / "currently watching" state and any
  // concurrent-stream accounting. Never awaited and never fatal.
  _logPlay(videoId, fileId, cmd) {
    this.client._stalkerCall({
      type:        'stb',
      action:      'log',
      real_action: 'play',
      content_id:  String(fileId || ''),
      tmp_type:    '2',
      id:          String(videoId),
      cmd:         cmd || '',
    })
      .then(() => log.debug(TAG, `play logged: id=${videoId} content_id=${fileId || ''}`))
      .catch(e => log.debug(TAG, `play log failed (non-fatal): ${e.message}`));
  }

  // ── Stream URL resolution ──────────────────────────────────────────────────

  // Mirrors api.py get_vod_stream_url() + stalkerhek's parseCreateLinkVOD:
  //   Primary: create_link (type=vod) → resolve the response, which may be a
  //            direct URL (js.url / js.cmd) OR an id + play_token pair that
  //            must be assembled into a play/movie.php URL (common movie-portal
  //            form). Many portals return ONLY the token form, so handling it is
  //            required for VOD to play at all.
  //   Fallbacks: listing cmd as a direct URL → legacy movie_id probe →
  //              constructed basePath + cmd path.
  //
  // Cached briefly: repeated calls for the same title (player reload, seek,
  // hls.js error-recovery) reuse the resolved URL instead of re-resolving
  // through the slow portal and risking the nothing_to_play fallback.
  // opts: { seasonId, episodeId } for TV-show episodes. For movies, omit them.
  async getStreamUrl(videoId, cmd, series = 0, opts = {}) {
    const { seasonId = '', episodeId = '' } = opts;
    const key = `${videoId}:${parseInt(series, 10) || 0}:${episodeId || ''}`;
    const hit = this._linkCache.get(key);
    if (hit && Date.now() - hit.ts < VOD_LINK_TTL_MS) {
      log.debug(TAG, `VOD link cache hit for ${key}`);
      return hit.url;
    }
    const url = await this._resolveStreamUrl(videoId, cmd, series, { seasonId, episodeId });
    this._linkCache.set(key, { url, ts: Date.now() });
    return url;
  }

  async _resolveStreamUrl(videoId, cmd, series = 0, opts = {}) {
    const { seasonId = '', episodeId = '' } = opts;
    // For a TV-show episode, `series` is the episode's series_number. For a movie
    // it must be omitted entirely — series=0 makes Ministra portals look for
    // "episode 0" of a series and answer nothing_to_play (STBemu omits it too).
    const seriesNum = parseInt(series, 10) || 0;
    const seriesParam = seriesNum > 0 ? { series: String(seriesNum) } : {};

    // Resolve the concrete file record the way STBemu does. For an episode this
    // is the episode_id drill-down; for a movie it's the movie_id lookup. Both
    // yield the FILE id (distinct from the video id) that create_link needs as
    // /media/file_<fileId>.mpg — the /media/<videoId>.mpg form the listing
    // advertises returns nothing_to_play on Ministra portals.
    const fileInfo = episodeId
      ? await this._getEpisodeFile(videoId, seasonId, episodeId)
      : await this._getMovieFile(videoId, seriesNum);

    // Build candidate cmd strings for create_link, most likely to work first.
    const candidates = [];
    if (fileInfo?.fileId) candidates.push(`/media/file_${fileInfo.fileId}.mpg`);
    if (cmd) {
      candidates.push(cmd);
      if (!cmd.startsWith('/') && !cmd.startsWith('http')) {
        candidates.push(`/media/${cmd}`);
      }
    }
    candidates.push(`/media/${videoId}.mpg`);
    const uniqueCandidates = [...new Set(candidates)];

    // Explicit error the portal returned from create_link (e.g. "nothing_to_play").
    // When present, the portal has no playable file — we must NOT fabricate a
    // /media/<id>.mpg URL, since that only yields a misleading 404.
    let portalError = null;

    // ── Primary: create_link (params mirror STBemu), resolve the response ──
    for (const candidate of uniqueCandidates) {
      try {
        log.debug(TAG, `VOD create_link for candidate: ${candidate}`);
        const r = await this.client._stalkerCall({
          type:                'vod',
          action:              'create_link',
          cmd:                 candidate,
          ...seriesParam,
          forced_storage:      '',
          disable_ad:          '0',
          download:            '0',
          force_ch_link_check: '0',
        });
        log.debug(TAG, `create_link js: ${JSON.stringify(r?.js)?.slice(0, 400)}`);
        const url = this._resolveCreateLink(r?.js);
        if (url) {
          log.info(TAG, `VOD stream resolved for "${candidate}": ${url.slice(0, 80)}…`);
          this._logPlay(videoId, fileInfo?.fileId, url);
          return url;
        }
        if (r?.js?.error) portalError = r.js.error;
      } catch (e) {
        log.warn(TAG, `create_link failed for candidate "${candidate}": ${e.message}`);
      }
    }

    // ── Fallback 1: the movie_id file record carried a direct playable URL ──
    if (fileInfo?.url) {
      log.info(TAG, `VOD stream resolved (movie_id file url): ${fileInfo.url.slice(0, 80)}…`);
      return fileInfo.url;
    }

    // ── Fallback 2: listing cmd is already a playable URL ──
    if (cmd) {
      const direct = this._extractUrl(cmd);
      if (direct) {
        log.info(TAG, `VOD stream resolved (direct listing url): ${direct.slice(0, 80)}…`);
        return direct;
      }
    }

    // The portal explicitly refused to create a link — the title has no
    // playable file on its storage. Surface that instead of fabricating a URL.
    if (portalError) {
      throw new Error(
        `Portal could not create a stream link (${portalError}). ` +
        `This title has no playable file on the portal's storage.`
      );
    }

    // ── Fallback 2: legacy play/movie.php?movie_id probe (older portals) ──
    // Demoted below create_link so it no longer adds a 10s timeout to every
    // successful play — only runs when create_link yields nothing.
    try {
      const playUrl = `${this.client.basePath}play/movie.php?movie_id=${videoId}`;
      log.info(TAG, `VOD legacy probe via play/movie.php?movie_id: ${playUrl}`);
      const response = await this.client.http.get(playUrl, {
        headers: this.client._buildHeaders(),
        timeout: 10000,
        maxRedirects: 10,
        validateStatus: (status) => status < 400,
      });

      const resolvedUrl = response.request?.res?.responseUrl || response.headers['location'];
      if (resolvedUrl && resolvedUrl !== playUrl && resolvedUrl.startsWith('http')) {
        log.info(TAG, `VOD resolved via movie_id redirect: ${resolvedUrl.slice(0, 80)}…`);
        return resolvedUrl;
      }

      const data = response.data;
      if (data) {
        const extracted = typeof data === 'string'
          ? this._extractUrl(data)
          : this._extractUrl(data.cmd || data.url);
        if (extracted) {
          log.info(TAG, `VOD resolved via movie_id data: ${extracted.slice(0, 80)}…`);
          return extracted;
        }
      }
    } catch (e) {
      log.warn(TAG, `legacy movie_id probe failed: ${e.message}`);
    }

    // ── Fallback 3: construct absolute URL from portal basePath + cmd ──
    // Some portals return "nothing_to_play" for create_link but serve the
    // /media/{id}.mpg path directly (authenticated via session cookies).
    const relCmd = cmd || `/media/${videoId}.mpg`;
    const base   = (this.client?.basePath || '').replace(/\/$/, '');
    if (base.startsWith('http')) {
      const constructed = base + '/' + relCmd.replace(/^\//, '');
      log.info(TAG, `VOD stream resolved (constructed basePath+cmd): ${constructed.slice(0, 80)}…`);
      return constructed;
    }

    throw new Error('Could not resolve VOD stream URL');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Build a browser-usable URL for a VOD screenshot/poster.
  // Portal screenshot_uri values are usually http:// and frequently require the
  // portal session (Cookie/User-Agent), so handing the raw portal URL to the
  // browser breaks on the web: blocked as mixed content on an HTTPS page, and
  // often 403 without auth. Instead route it through /api/logos/render, which
  // fetches server-side with the portal headers, caches it, and serves it
  // same-origin — exactly how channel logos are handled.
  resolveScreenshot(uri) {
    const abs = this._absoluteScreenshotUrl(uri);
    return abs ? `/api/logos/render?url=${encodeURIComponent(abs)}` : null;
  }

  // Resolve a portal-relative screenshot URI to an absolute portal URL.
  _absoluteScreenshotUrl(uri) {
    if (!uri) return null;
    if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
    const basePath = this.client?.basePath || '';
    if (!basePath) return null;
    // A leading-slash URI (e.g. "/stalker_portal/misc/logos/250/1.png") is an
    // absolute path → join it to the portal ORIGIN, not the deeper basePath,
    // otherwise the "/stalker_portal/" segment gets duplicated and 404s.
    if (uri.startsWith('/')) {
      try { return new URL(basePath).origin + uri; }
      catch { return null; }
    }
    return basePath.replace(/\/$/, '') + '/' + uri;
  }

  // Resolve a playable URL from a create_link js response.
  // Handles the three portal variants, matching stalkerhek's parseCreateLinkVOD:
  //   1. js.url / js.cmd / bare-string js — a direct http(s) URL
  //   2. js.id + js.play_token — assemble a play/movie.php URL (the common
  //      movie-portal form, where cmd carries no playable URL)
  _resolveCreateLink(js) {
    if (!js) return null;

    // Bare string response — treat as a cmd.
    if (typeof js === 'string') return this._extractUrl(js);

    // 1. Direct URL in js.url or js.cmd.
    const direct = this._extractUrl(js.url) || this._extractUrl(js.cmd);
    if (direct) return direct;

    // 2. id + play_token → play/movie.php gateway URL.
    return this._buildMoviePhpUrl(js);
  }

  // Build a play/movie.php URL from a create_link response's id + play_token.
  // Mirrors stalkerhek's buildMoviePlayURL():
  //   {basePath}play/movie.php?mac=<mac>&stream=<id|+.mp4>&play_token=<token>&type=vod
  _buildMoviePhpUrl(js) {
    const mac   = this.client?.identity?.mac;
    const token = js.play_token != null ? String(js.play_token).trim() : '';
    let stream  = js.id != null ? String(js.id).trim() : '';
    if (!mac || !token || !stream) return null;

    // Portal expects a filename; append .mp4 when the id has no extension.
    if (!stream.includes('.')) stream += '.mp4';

    const base = (this.client?.basePath || '').replace(/\/$/, '');
    if (!base.startsWith('http')) return null;

    const params = new URLSearchParams({
      mac,
      stream,
      play_token: token,
      type: 'vod',
    });
    return `${base}/play/movie.php?${params.toString()}`;
  }

  // Strip the "ffrt<n> " or "ffmpeg " prefix that Stalker portals prepend to
  // stream commands, then validate what remains is an http(s) URL.
  _extractUrl(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const spacePos = s.indexOf(' ');
    const url = spacePos !== -1 ? s.slice(spacePos + 1).trim() : s;
    return (url.startsWith('http://') || url.startsWith('https://')) ? url : null;
  }

  _normalizeItem(item) {
    // Log ALL fields on the first few items so we can spot portal-specific
    // stream URL fields (e.g. stream_url, link, direct_links) that STBEmu
    // might use but that we're currently discarding.
    if (this._loggedItems === undefined) this._loggedItems = 0;
    if (this._loggedItems < 2) {
      log.debug(TAG, `raw VOD item: ${JSON.stringify(item)}`);
      this._loggedItems++;
    }

    return {
      id:          String(item.id || ''),
      name:        item.name || item.title || '',
      description: item.description || '',
      director:    item.director || '',
      actors:      item.actors || '',
      year:        String(item.year || ''),
      country:     item.country || '',
      durationMin: parseInt(item.time || '0', 10) || 0,
      isHD:        !!item.hd,
      isFav:       !!(item.fav),
      isSeries:    !!Number(item.is_series),
      // Not every portal fills these in; empty and 0 when it doesn't.
      genres:      String(item.genres_str || '').split(',').map((g) => g.trim()).filter(Boolean),
      rating:      parseFloat(item.rating_imdb) || 0,
      episodes:    Array.isArray(item.series) ? item.series : [],
      screenshotUri: item.screenshot_uri || item.screenshot || item.screenshot_url || null,
      cmd:          item.cmd || item.path || '',
      // Preserve any extra streaming URL fields the portal may include
      streamUrl:    item.stream_url || item.link || item.url || null,
      added:        item.added || '',
      categoryId:   String(item.category_id || ''),
    };
  }
}

module.exports = VodManager;
