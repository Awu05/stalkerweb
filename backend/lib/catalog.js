'use strict';

// The portal's catalog as the "app-style" exports see it — the Xtream API and
// the Stremio addon. Both browse live TV, movies and series by category, so
// they share this: the same filters (hidden genres and languages, adult
// content), the same rate-limit-friendly listing, and the same per-portal
// caches, so one client's browsing warms the other's.

const log = require('../logger');
const { groupChannels } = require('../routes/m3u');
const { isAdult } = require('./exportFilter');
const { visibleVodCategories } = require('./vodCategoryFilter');
const TAG = 'catalog';

const ALL_CATEGORIES_ID = '*';              // the portal's "everything" pseudo-category
const SYNTHETIC_CATEGORY_BASE = 900000;     // live categories with no numeric portal id
const SERIES_INFO_TTL_MS = 60 * 60 * 1000;
const ALL_TITLES_WAIT_MS = 20 * 1000;       // see listTitles
const NO_SERIES_RECHECK_MS = 30 * 60 * 1000; // see seriesSource

// Live categories in playlist order. Portal genre ids are kept where numeric
// (Xtream clients parse category ids as integers); others get a synthetic id.
function liveCatalog(channels, groups) {
  const idByName = new Map(groups.map((g) => [g.name, String(g.id)]));
  const categories = [];
  const categoryOf = new Map(); // group name → category id
  const streams = groupChannels(channels, groups).map(({ ch, group }, i) => {
    if (!categoryOf.has(group)) {
      const portalId = idByName.get(group);
      const id = portalId && /^\d+$/.test(portalId) ? portalId : String(SYNTHETIC_CATEGORY_BASE + categories.length);
      categoryOf.set(group, id);
      categories.push({ id, name: group });
    }
    return { ch, num: i + 1, categoryId: categoryOf.get(group) };
  });
  return { categories, streams };
}

function createCatalog(appState, { logoManager = null, idStore, allTitlesWaitMs = ALL_TITLES_WAIT_MS } = {}) {
  // Per-portal state, dropped when a different portal is connected so nothing
  // from one catalog is served for another.
  //   titles:  `${type}:${id}` → title seen in a listing — for movie info, a
  //            movie's cmd at play time, and a show's episodes when the portal
  //            has no seasons. Keyed by type: a movie and a show can share an id.
  //   seasons: seriesId → { value: portal seasons + episodes, ts }
  //   noSeriesUntil: when the portal rejected type=series, the time until which
  //            it is taken to have no series section (so it isn't asked again
  //            on every request — a failure is not cached by VodManager).
  let scope = { portal: null, titles: new Map(), seasons: new Map(), noSeriesUntil: 0 };
  const currentPortal = () => appState.client?.getBasePath?.() || '';
  function state() {
    const portal = currentPortal();
    if (scope.portal !== portal) scope = { portal, titles: new Map(), seasons: new Map(), noSeriesUntil: 0 };
    return scope;
  }

  // "Every movie" listings walk all categories in the background; requests wait
  // a while for that walk, then answer with what is cached so far.
  const fills = new Map(); // `${portal}|${type}` → promise

  const showAdult = () => appState.getShowAdult?.() === true;
  const hiddenLanguages = () => appState.getHiddenLanguages?.() ?? new Set();
  const hiddenVodCategories = () => appState.getHiddenVodCategories?.() ?? new Set();

  const logoFor = (ch) => (logoManager ? logoManager.resolveOverride(ch.name) : '')
    || ch.iconPath
    || (logoManager ? logoManager.resolveDbLogo(ch.name) : '')
    || '';

  // Absolute poster URL for a portal screenshot, served through this server.
  const posterFor = (base, uri) => {
    const rel = uri ? appState.vodManager?.resolveScreenshot(uri) : null;
    return rel ? base + rel : '';
  };

  // ── Live ───────────────────────────────────────────────────────────────────

  /** Live categories and channels, filtered; `categoryId` narrows the channels. */
  function liveData(categoryId = null) {
    const { channelManager } = appState;
    const keep = appState.getExportFilter?.().keep ?? (() => true);
    const shown = channelManager.getChannels().filter(keep);
    const catalog = liveCatalog(shown, channelManager.getGroups());
    if (categoryId) catalog.streams = catalog.streams.filter((s) => s.categoryId === String(categoryId));
    return catalog;
  }

  // ── Movie / series categories ──────────────────────────────────────────────

  async function visibleCategories(type) {
    const adult = showAdult();
    const all = await appState.vodManager.getCategories(type);
    const shown = visibleVodCategories(all, { hiddenCategories: hiddenVodCategories(), hiddenLanguages: hiddenLanguages() });
    return shown.filter((c) => String(c.id) !== ALL_CATEGORIES_ID && (adult || !isAdult(c.title)));
  }

  // Series live in the portal's "series" section when it has one; otherwise
  // shows are mixed into the movie categories, flagged is_series. Portals
  // without a series module reject type=series outright; that means "no
  // series section", not an error.
  async function seriesSource() {
    const s = state();
    let own = [];
    if (Date.now() >= s.noSeriesUntil) {
      try {
        own = await visibleCategories('series');
      } catch (e) {
        s.noSeriesUntil = Date.now() + NO_SERIES_RECHECK_MS;
        log.debug(TAG, `series categories unavailable (${e.message}) — using movie categories`);
      }
    }
    return own.length ? { type: 'series', categories: own, all: true } : { type: 'vod', categories: await visibleCategories('vod'), all: false };
  }

  // Reads every category's listing in the background, one after another. One
  // walk per portal and type, however many requests ask.
  function fillAll(type, categories) {
    const key = `${currentPortal()}|${type}`;
    if (!fills.has(key)) {
      const walk = (async () => {
        for (const c of categories) {
          try {
            await appState.vodManager.getAllItems(type, c.id);
          } catch (e) {
            log.warn(TAG, `listing ${type}/${c.id} failed: ${e.message}`);
          }
        }
      })().finally(() => fills.delete(key));
      fills.set(key, walk);
    }
    return fills.get(key);
  }

  // Titles of one category, or of every given category when none is named.
  // A full catalog can take minutes to read, longer than players wait for an
  // answer, so the all-categories form waits up to allTitlesWaitMs and then
  // answers with what has been read; the rest fills in for the next request.
  // Returns [{ item, categoryId }].
  async function listTitles(type, categories, categoryId = null) {
    const { vodManager } = appState;
    const { titles } = state();
    const out = [];
    const add = (c, items) => {
      for (const item of items) {
        titles.set(`${type}:${item.id}`, item);
        out.push({ item, categoryId: String(c.id) });
      }
    };

    if (categoryId) {
      const c = categories.find((cat) => String(cat.id) === String(categoryId));
      if (c) add(c, await vodManager.getAllItems(type, c.id));
      return out;
    }

    const walk = fillAll(type, categories);
    let timer;
    await Promise.race([walk, new Promise((r) => { timer = setTimeout(r, allTitlesWaitMs); })]);
    clearTimeout(timer);
    for (const c of categories) add(c, vodManager.peekAllItems(type, c.id) ?? []);
    return out;
  }

  /** Movies (is_series titles excluded) of one category, or of all. */
  async function listMovies(categoryId = null) {
    const rows = await listTitles('vod', await visibleCategories('vod'), categoryId);
    return rows.filter(({ item }) => !item.isSeries);
  }

  /** Shows of one category, or of all — from wherever the portal keeps them. */
  async function listShows(categoryId = null) {
    const src = await seriesSource();
    const rows = await listTitles(src.type, src.categories, categoryId);
    return rows.filter(({ item }) => src.all || item.isSeries);
  }

  /**
   * Movies or shows matching `query`, from the portal's own search (one batch
   * of results). Titles in hidden categories, and adult ones unless allowed,
   * are left out. Returns [{ item, categoryId }].
   */
  async function searchTitles(kind, query) {
    const src = kind === 'movie'
      ? { type: 'vod', categories: await visibleCategories('vod'), all: false }
      : await seriesSource();
    const visible = new Set(src.categories.map((c) => String(c.id)));
    const adult = showAdult();
    // Taken before the portal call: if the portal changes meanwhile, these
    // results must not land in the new portal's titles.
    const { titles } = state();
    const { items } = await appState.vodManager.getItems({ type: src.type, categoryId: ALL_CATEGORIES_ID, search: query });
    const out = [];
    for (const item of items) {
      if (kind === 'movie' ? item.isSeries : !(src.all || item.isSeries)) continue;
      if (item.categoryId && !visible.has(String(item.categoryId))) continue;
      if (!adult && isAdult(item.name)) continue;
      titles.set(`${src.type}:${item.id}`, item);
      out.push({ item, categoryId: String(item.categoryId || '') });
    }
    return out;
  }

  /**
   * One screen of a movie or series category: titles `skip`…`skip + limit - 1`.
   * Served from the full listing when it is cached; otherwise only the portal
   * pages covering the screen are read, so a big category answers quickly,
   * and the full listing is read in the background for the screens after it.
   * Titles of the other kind (shows among movies, when the portal mixes them)
   * are dropped, so a screen read that way can come up short.
   * Returns [{ item, categoryId }].
   */
  async function pageOfTitles(kind, categoryId, skip, limit) {
    const src = kind === 'movie' ? { type: 'vod', all: false } : await seriesSource();
    const keep = (item) => (kind === 'movie' ? !item.isSeries : (src.all || item.isSeries));
    const { vodManager } = appState;
    const { titles } = state();
    let items;
    const full = vodManager.peekAllItems(src.type, categoryId);
    if (full) {
      items = full.filter(keep).slice(skip, skip + limit);
    } else {
      items = (await vodManager.getRange(src.type, categoryId, skip, limit)).items.filter(keep);
      vodManager.getAllItems(src.type, categoryId).catch((e) => log.warn(TAG, `listing ${src.type}/${categoryId}: ${e.message}`));
    }
    for (const item of items) titles.set(`${src.type}:${item.id}`, item);
    return items.map((item) => ({ item, categoryId: String(categoryId) }));
  }

  const findMovie = (id) => state().titles.get(`vod:${id}`);
  // A show by id, from either listing it can appear in.
  const findShow = (id) => {
    const { titles } = state();
    return titles.get(`series:${id}`) ?? titles.get(`vod:${id}`);
  };

  // A show's seasons and their episodes from the portal: one request for the
  // seasons, then one per season. Cached, since players reopen a show often.
  // Only the portal's data is cached — responses are built per request, so
  // image URLs follow each caller's own address.
  async function portalSeasons(seriesId) {
    const { seasons } = state();
    const hit = seasons.get(String(seriesId));
    if (hit && Date.now() - hit.ts < SERIES_INFO_TTL_MS) return hit.value;

    const { vodManager } = appState;
    const value = [];
    for (const season of await vodManager.getSeasons(seriesId)) {
      value.push({ season, episodes: await vodManager.getEpisodes(seriesId, season.id) });
    }
    seasons.set(String(seriesId), { value, ts: Date.now() });
    return value;
  }

  /**
   * A show's seasons with their episodes, each episode given its stable
   * numeric id (see XtreamIdStore). Older portals list episodes as plain
   * numbers on the title itself; those become one "Season 1".
   * Returns [{ number, name, imageUri, episodes: [{ id, number, title, imageUri }] }].
   */
  async function seasonsOf(seriesId) {
    const portal = currentPortal();
    const out = [];
    for (const [i, { season: s, episodes: eps }] of (await portalSeasons(seriesId)).entries()) {
      out.push({
        number: parseInt(s.seasonNumber, 10) || i + 1,
        name: s.name,
        imageUri: s.screenshotUri,
        episodes: eps.map((e, j) => {
          const number = parseInt(e.seriesNumber, 10) || j + 1;
          return {
            id: idStore.idFor({ portal, showId: seriesId, seasonId: s.id, episodeId: e.episodeId, series: number }),
            number,
            title: e.name,
            imageUri: e.screenshotUri || s.screenshotUri,
          };
        }),
      });
    }
    const show = findShow(seriesId);
    if (!out.length && show?.episodes?.length) {
      out.push({
        number: 1,
        name: 'Season 1',
        imageUri: show.screenshotUri,
        episodes: show.episodes.map((n) => ({
          id: idStore.idFor({ portal, showId: seriesId, series: Number(n) }),
          number: Number(n),
          title: `Episode ${n}`,
          imageUri: show.screenshotUri,
        })),
      });
    }
    return out;
  }

  // ── Playback ───────────────────────────────────────────────────────────────
  // Paths into the existing /proxy routes, so tokens, retries and HLS rewriting
  // behave exactly as they do for the web player.

  const liveProxyPath = (channelId) => `/stream/${encodeURIComponent(channelId)}`;

  function movieProxyPath(videoId) {
    const p = new URLSearchParams({ videoId: String(videoId) });
    const cmd = findMovie(videoId)?.cmd;
    if (cmd) p.set('cmd', cmd);
    return `/vod/stream?${p}`;
  }

  /** The proxy path for an episode id, or { error } when it can't be played. */
  function episodeProxyPath(episodeId) {
    const ep = idStore.get(episodeId);
    if (!ep) return { error: 'Unknown episode — reopen the show to refresh its episode list' };
    if (ep.portal !== currentPortal()) return { error: 'This episode is from another portal — reopen the show to refresh its episode list' };
    const p = new URLSearchParams({ videoId: ep.showId });
    if (ep.series)    p.set('series', String(ep.series));
    if (ep.seasonId)  p.set('seasonId', ep.seasonId);
    if (ep.episodeId) p.set('episodeId', ep.episodeId);
    return { path: `/vod/stream?${p}` };
  }

  return {
    currentPortal, logoFor, posterFor,
    liveData, visibleCategories, seriesSource,
    listMovies, listShows, pageOfTitles, searchTitles, findMovie, findShow, seasonsOf,
    liveProxyPath, movieProxyPath, episodeProxyPath,
  };
}

module.exports = { createCatalog, liveCatalog };
