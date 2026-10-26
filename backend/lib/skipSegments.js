'use strict';

// Skip intro / recap / credits for movies and episodes.
//
// The portal has no such marks, so they come from IntroDB (api.introdb.app),
// a free community database of intro, recap and outro times, read without a
// key. It knows titles by IMDb id, which the portal doesn't send either: the
// show is found by its name and year with IMDb's own title search (the one
// behind imdb.com's search box, also keyless). The id found is kept per show,
// on disk; a viewer can set the right one, or turn a show off, when the name
// finds the wrong one (PUT /api/vod/skip/match/:videoId).
//
// Neither site is needed to play: if either is slow or down, the player
// simply shows no skip buttons.

const fs = require('fs');
const log = require('../logger');
const TAG = 'skip';

const IMDB_SEARCH = 'https://v2.sg.media-imdb.com/suggestion';
const INTRODB = 'https://api.introdb.app/segments';
const TIMEOUT_MS = 6000;

const FOUND_TTL_MS = 12 * 60 * 60 * 1000;       // times known: asked again twice a day
const MISSING_TTL_MS = 3 * 60 * 60 * 1000;      // nothing submitted yet: every few hours
const NO_MATCH_RETRY_MS = 3 * 24 * 60 * 60 * 1000;   // a name IMDb didn't know
const MAX_CACHED = 2000;
const SAVE_DELAY_MS = 1000;

const SERIES_KINDS = new Set(['tvSeries', 'tvMiniSeries']);
const MOVIE_KINDS = new Set(['movie', 'tvMovie']);
const IMDB_ID = /^tt\d{5,10}$/;

/**
 * What the portal calls a title, as IMDb would: provider tags, quality and
 * language marks, a season and the year taken off. "EN - Breaking Bad (2008)
 * S02 [4K]" → { title: 'Breaking Bad', year: '2008', season: '2' }.
 */
function cleanTitle(name) {
  let s = String(name || '').replace(/[._]+/g, ' ').trim();
  let year = '';
  let season = '';
  // "EN - ", "|EN| ", "[EN] ", "UK| " — a short provider or language tag in
  // front (not "CSI: Miami": a colon is part of a name).
  s = s.replace(/^\s*(?:[|[(]\s*[A-Z0-9+]{2,6}\s*[|\])]|[A-Z]{2,3}\s+-\s+|[A-Z]{2,4}\s*\|)\s*/, '');
  // Bracketed marks anywhere: "[4K]", "(MULTI-SUB)" — but keep a year aside.
  s = s.replace(/[[(]\s*((?:19|20)\d{2})\s*[\])]/g, (_m, y) => { year ||= y; return ' '; });
  s = s.replace(/[[(][^\])]*[\])]/g, ' ');
  const seasonMark = /\b(?:S(\d{1,2})(?:\s*E\d{1,3})?|Season\s*(\d{1,2})|Saison\s*(\d{1,2})|Staffel\s*(\d{1,2})|Temporada\s*(\d{1,2}))\b/i;
  const m = seasonMark.exec(s);
  if (m) {
    season = String(Number(m.slice(1).find(Boolean)));
    s = s.slice(0, m.index);
  }
  s = s.replace(/\b(?:4K|UHD|FHD|HD|SD|HEVC|H ?26[45]|1080p|720p|2160p|MULTI(?:[ -]?(?:SUB|AUDIO))?|VOSTFR|DUAL|SUB|DUB)\b/gi, ' ');
  // A bare year at the end: "Dune 2021" — not one in the future ("Blade
  // Runner 2049") or the whole name ("1917").
  s = s.replace(/(\S)\s+((?:19|20)\d{2})\s*$/, (m, before, y) => {
    if (Number(y) > new Date().getFullYear() + 1) return m;
    year ||= y;
    return before;
  });
  s = s.replace(/\s*[-:|–]\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: s, year, season };
}

// Titles compared without case, accents, punctuation or a leading "The".
const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');

/**
 * The IMDb id that best fits a title, from IMDb's suggestions (`d` of its
 * answer): of the right kind (series or movie), the same name and year
 * winning, then IMDb's own order. Null when none of the right kind.
 */
function pickImdb(suggestions, { title, year, isMovie }) {
  const kinds = isMovie ? MOVIE_KINDS : SERIES_KINDS;
  const want = plain(title);
  const y = parseInt(year, 10) || 0;
  let best = null;
  (Array.isArray(suggestions) ? suggestions : []).forEach((s, i) => {
    if (!IMDB_ID.test(s?.id || '') || !kinds.has(s.qid)) return;
    let score = 0;
    if (plain(s.l) === want) score += 2;
    // A show's year on the portal can be any of its seasons'.
    const from = Number(s.y) || 0;
    const to = Number(String(s.yr || '').split('-')[1]) || from;
    if (y && from && (isMovie ? Math.abs(from - y) <= 1 : y >= from - 1 && y <= (to || 9999) + 1)) score += 2;
    if (!best || score > best.score || (score === best.score && i < best.i)) best = { id: s.id, title: s.l, year: s.y ? String(s.y) : '', score, i };
  });
  // Neither the name nor the year agrees: more likely another title than this one.
  if (best && best.score === 0 && y) return null;
  return best && { id: best.id, title: best.title, year: best.year };
}

// One of IntroDB's segments as the player uses it: seconds, start before end.
function segmentOf(s) {
  const start = Number(s?.start_sec);
  const end = Number(s?.end_sec);
  return Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0 ? { start, end } : null;
}

/** IntroDB's answer as { intro, recap, outro }, each { start, end } or null. */
function segmentsOf(body) {
  return { intro: segmentOf(body?.intro), recap: segmentOf(body?.recap), outro: segmentOf(body?.outro) };
}

const NONE = Object.freeze({ intro: null, recap: null, outro: null });

class SkipSegments {
  /**
   * @param {string|null} file  where each show's IMDb id is kept; null: in memory.
   * @param {{ fetch?: Function }} [opts]  fetch, replaceable in tests.
   */
  constructor(file, { fetch: fetchFn = globalThis.fetch } = {}) {
    this._file = file;
    this._fetch = fetchFn;
    this._shows = {};            // `${portal}|${videoId}` → { imdbId, title, year, set, off, at }
    this._times = new Map();     // `${imdbId}|${season}|${episode}` → { value, at, ttl }
    this._pending = new Map();   // the same keys and show keys → a lookup under way
    this._timer = null;
    this._load();
  }

  _load() {
    if (!this._file) return;
    try { this._shows = JSON.parse(fs.readFileSync(this._file, 'utf8')).shows || {}; } catch { /* first run */ }
  }

  _scheduleSave() {
    if (!this._file || this._timer) return;
    this._timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this._timer.unref?.();
  }

  /** Writes unsaved matches now (on shutdown). */
  flush() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ shows: this._shows }), 'utf8');
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log.error(TAG, `save failed: ${e.message}`);
    }
  }

  async _json(url) {
    const r = await this._fetch(url, { signal: globalThis.AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r.json();
  }

  async _search(title, year, isMovie) {
    const q = plain(title);
    if (!q) return null;
    const first = /^[a-z0-9]/.test(q) ? q[0] : 'x';
    const body = await this._json(`${IMDB_SEARCH}/${first}/${encodeURIComponent(q)}.json`);
    return pickImdb(body?.d, { title, year, isMovie });
  }

  /** The match kept for a show, as the player shows it: { imdbId, title, year, set, off } or null. */
  match(portal, videoId) {
    const m = this._shows[`${portal}|${videoId}`];
    return m ? { imdbId: m.imdbId ?? null, title: m.title ?? '', year: m.year ?? '', set: !!m.set, off: !!m.off } : null;
  }

  /**
   * A viewer's choice for a show: an IMDb id ("tt0903747", or a link to its
   * page), 'off' for no skipping, or null to find it by name again.
   */
  setMatch(portal, videoId, choice) {
    const key = `${portal}|${videoId}`;
    if (choice === null || choice === undefined || choice === '') {
      delete this._shows[key];
    } else if (choice === 'off') {
      this._shows[key] = { imdbId: null, set: true, off: true, at: Date.now() };
    } else {
      const id = /tt\d{5,10}/.exec(String(choice))?.[0];
      if (!id) throw Object.assign(new Error('That is not an IMDb id — it looks like tt0903747.'), { status: 400 });
      this._shows[key] = { imdbId: id, title: '', year: '', set: true, off: false, at: Date.now() };
    }
    this._scheduleSave();
    return this.match(portal, videoId);
  }

  // The show's IMDb match: kept, or looked up now (once at a time per show).
  async _matchFor(portal, videoId, title, year, isMovie) {
    const key = `${portal}|${videoId}`;
    const kept = this._shows[key];
    if (kept && (kept.set || kept.imdbId || Date.now() - (kept.at || 0) < NO_MATCH_RETRY_MS)) return kept;
    if (!this._pending.has(key)) {
      this._pending.set(key, (async () => {
        const found = await this._search(title, year, isMovie);
        const m = { imdbId: found?.id ?? null, title: found?.title ?? '', year: found?.year ?? '', set: false, off: false, at: Date.now() };
        if (!this._shows[key]?.set) { this._shows[key] = m; this._scheduleSave(); }
        log.info(TAG, `"${title}"${year ? ` (${year})` : ''} → ${m.imdbId ? `${m.title} (${m.year}) ${m.imdbId}` : 'not found on IMDb'}`);
        return this._shows[key];
      })().finally(() => this._pending.delete(key)));
    }
    return this._pending.get(key);
  }

  async _timesFor(imdbId, season, episode, isMovie) {
    const key = isMovie ? `${imdbId}|movie` : `${imdbId}|${season}|${episode}`;
    const hit = this._times.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    if (!this._pending.has(key)) {
      const p = new URLSearchParams({ imdb_id: imdbId });
      if (isMovie) p.set('is_movie', 'true'); else { p.set('season', String(season)); p.set('episode', String(episode)); }
      this._pending.set(key, this._json(`${INTRODB}?${p}`).then((body) => {
        const value = body ? segmentsOf(body) : NONE;
        const found = !!(value.intro || value.recap || value.outro);
        this._times.delete(key);
        this._times.set(key, { value, at: Date.now(), ttl: found ? FOUND_TTL_MS : MISSING_TTL_MS });
        // Oldest out first (a Map keeps the order things were put in).
        while (this._times.size > MAX_CACHED) this._times.delete(this._times.keys().next().value);
        return value;
      }).finally(() => this._pending.delete(key)));
    }
    return this._pending.get(key);
  }

  /**
   * The parts of a movie or episode that can be skipped:
   * { imdbId, match: { title, year, set, off }, intro, recap, outro }, each
   * part { start, end } in seconds or null. `name` is the portal's title of
   * the movie or show; `season` and `episode` numbers for an episode (the
   * season taken from the name when not given). Never throws: a site that
   * can't be reached means nothing to skip.
   */
  async lookup({ portal = '', videoId, name, year = '', season = '', episode = '', isMovie = false }) {
    const clean = cleanTitle(name);
    const y = String(year || '').match(/(?:19|20)\d{2}/)?.[0] || clean.year;
    const s = parseInt(season, 10) || parseInt(clean.season, 10) || (isMovie ? 0 : 1);
    const e = parseInt(episode, 10) || 0;
    const answer = (m, parts = NONE) => ({
      imdbId: m?.imdbId ?? null,
      match: { title: m?.title ?? '', year: m?.year ?? '', set: !!m?.set, off: !!m?.off },
      ...parts,
    });
    if (!videoId || !clean.title || (!isMovie && !e)) return answer(null);
    let m = null;
    try {
      m = await this._matchFor(portal, String(videoId), clean.title, y, isMovie);
      if (!m?.imdbId || m.off) return answer(m);
      return answer(m, await this._timesFor(m.imdbId, s, e, isMovie));
    } catch (err) {
      log.warn(TAG, `"${clean.title}": ${err.message}`);
      return answer(m);
    }
  }
}

module.exports = { SkipSegments, cleanTitle, pickImdb, segmentsOf };
