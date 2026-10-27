'use strict';

// Online subtitles for the VOD players' subtitle menu, next to the ones in the
// video itself (which the players read on their own). From one of two sites,
// chosen in Settings → Playback:
//   Wyzie Subs     several subtitle sites in one, with a free key: 1,000
//                  requests a day (the default);
//   OpenSubtitles  a free key gives 5 downloads a day, 20 with an account.
// Titles are found by IMDb id — the one skip intro already matched
// (lib/skipSegments.js).
//
// A downloaded file is kept on disk, so playing it again (or on another
// device, or with another delay) costs no download. It's served as WebVTT —
// what both the browser and the apps' player take — with the viewer's delay
// applied (`offset`, seconds: + later, − earlier).

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const TAG = 'subtitles';

const TIMEOUT_MS = 8000;
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;   // a login is good for a day; asked again sooner
const MAX_FILES = 300;                      // downloaded files kept, newest

// ── SRT / WebVTT ─────────────────────────────────────────────────────────────

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function secondsOf(stamp) {
  const m = TIME.exec(stamp);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function stampOf(secs) {
  const ms = Math.max(0, Math.round(secs * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

/**
 * An SRT (or WebVTT) file as WebVTT, every cue moved by `offset` seconds.
 * Cues moved before the start are dropped; styling tags SRT files carry from
 * ASS ("{\an8}") are taken out.
 */
function toWebVtt(text, offset = 0) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = ['WEBVTT', ''];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    const start = secondsOf(from);
    const end = secondsOf(to);
    if (start === null || end === null) continue;
    const s = start + offset;
    const e = end + offset;
    if (e <= 0) continue;
    const body = lines.slice(at + 1).join('\n').replace(/\{\\[^}]*\}/g, '').trim();
    if (!body) continue;
    out.push(`${stampOf(s)} --> ${stampOf(e)}`, body, '');
  }
  return out.join('\n');
}

// A downloaded file as text: UTF-8, or — older files — Windows-1252.
function decodeSubtitle(buf) {
  const bytes = new Uint8Array(buf);
  try {
    return new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new globalThis.TextDecoder('windows-1252').decode(bytes);
  }
}

// The status a failed lookup is answered with: the daily limit as itself, the rest a bad gateway.
const failure = (site, why, status) =>
  Object.assign(new Error(`${site}: ${why}`), { status: status === 406 || status === 429 ? 429 : 502 });

// ── Wyzie Subs ───────────────────────────────────────────────────────────────
// sub.wyzie.io: several subtitle sites in one search, by IMDb id, with a free
// key (1,000 requests a day — a search is one, each file one more). Its file
// links carry a token, so they're kept from the search and looked up by our id.

const WYZIE = 'https://sub.wyzie.io';
const WYZIE_SOURCES = 'charlie';   // the source a free key may search

/** Wyzie's search answer as the players list it ("w" ids, the link kept apart). */
function wyzieResultsOf(body) {
  const list = [];
  for (const r of Array.isArray(body) ? body : []) {
    const id = String(r?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
    if (!id || !/^https:\/\//.test(r?.url || '')) continue;
    list.push({
      fileId: `w${id}`,
      url: r.url,
      language: String(r.language || ''),
      label: String(r.release || r.fileName || '').trim(),
      downloads: Number(r.downloadCount) || 0,
      hearingImpaired: r.isHearingImpaired === true,
      machine: r.ai === true,
      source: String(r.source || ''),
    });
  }
  return list;
}

// ── OpenSubtitles ───────────────────────────────────────────────────────────

const OPENSUBTITLES = 'https://api.opensubtitles.com/api/v1';
const imdbNumber = (id) => String(id || '').replace(/^tt/, '').replace(/^0+/, '');

/** OpenSubtitles' search answer as the players list it. */
function resultsOf(body) {
  const list = [];
  for (const d of Array.isArray(body?.data) ? body.data : []) {
    const a = d?.attributes ?? {};
    const file = Array.isArray(a.files) ? a.files[0] : null;
    if (!file?.file_id) continue;
    list.push({
      fileId: String(file.file_id),
      language: String(a.language || ''),
      label: String(a.release || file.file_name || '').trim(),
      downloads: Number(a.download_count) || 0,
      hearingImpaired: a.hearing_impaired === true,
      machine: a.machine_translated === true || a.ai_translated === true,
      source: 'OpenSubtitles',
    });
  }
  return list;
}

// By language, people-made first, the most downloaded first.
const inOrder = (list) => list.slice().sort((x, y) =>
  x.language.localeCompare(y.language) || Number(x.machine) - Number(y.machine) || y.downloads - x.downloads);

// A subtitle file's id: OpenSubtitles' number, or "w" and Wyzie's.
const FILE_ID = /^(?:\d{1,12}|w[A-Za-z0-9_-]{1,60})$/;

class Subtitles {
  /**
   * @param {string|null} dir  where downloaded files are kept; null: in memory.
   * @param {{ settings: () => { provider, wyzieKey, apiKey, username, password, languages }, userAgent?: string, fetch?: Function }} opts
   *   provider 'wyzie' (the default) or 'opensubtitles'; apiKey, username and password are OpenSubtitles'.
   */
  constructor(dir, { settings, userAgent = 'StalkerWeb', fetch: fetchFn = globalThis.fetch }) {
    this._dir = dir;
    this._settings = settings;
    this._ua = userAgent;
    this._fetch = fetchFn;
    this._searches = new Map();   // key → { results, at }
    this._links = new Map();      // a Wyzie file id → its link, from the search
    this._memory = new Map();     // fileId → text (no dir)
    this._login = null;           // { key, token, base, at }
    this._pending = new Map();    // fileId → a download under way
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  _provider() {
    return this._settings().provider === 'opensubtitles' ? 'opensubtitles' : 'wyzie';
  }

  /** Whether the chosen site has its key (the players offer online subtitles only then). */
  configured() {
    const s = this._settings();
    return this._provider() === 'wyzie' ? !!s.wyzieKey : !!s.apiKey;
  }

  /** The chosen site's name, as the players show it. */
  providerName() {
    return this._provider() === 'wyzie' ? 'Wyzie Subs' : 'OpenSubtitles';
  }

  _languages() {
    return String(this._settings().languages || '').toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(',');
  }

  async _get(url, init = {}) {
    return this._fetch(url, { signal: globalThis.AbortSignal.timeout(TIMEOUT_MS), ...init });
  }

  async _openSubtitles(method, url, { body, token } = {}) {
    const r = await this._get(url, {
      method,
      headers: {
        'Api-Key': this._settings().apiKey,
        'User-Agent': this._ua,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw failure('OpenSubtitles', json?.message || json?.errors?.[0] || `answered ${r.status}`, r.status);
    return json;
  }

  // The OpenSubtitles account's login, when one is set: more downloads a day. Kept for a while.
  async _token() {
    const { apiKey, username, password } = this._settings();
    if (!username || !password) return null;
    const key = `${apiKey}|${username}|${password}`;
    if (this._login?.key === key && Date.now() - this._login.at < TOKEN_TTL_MS) return this._login;
    const r = await this._openSubtitles('POST', `${OPENSUBTITLES}/login`, { body: { username, password } });
    const base = r?.base_url ? `https://${String(r.base_url).replace(/^https?:\/\//, '')}/api/v1` : OPENSUBTITLES;
    this._login = { key, token: r?.token || null, base, at: Date.now() };
    return this._login;
  }

  async _searchWyzie({ imdbId, season, episode, isMovie }) {
    const p = new URLSearchParams({ id: imdbId, format: 'srt', source: WYZIE_SOURCES });
    if (!isMovie) { p.set('season', String(season)); p.set('episode', String(episode)); }
    const languages = this._languages();
    if (languages) p.set('language', languages);
    p.set('key', this._settings().wyzieKey);
    const r = await this._get(`${WYZIE}/search?${p}`, { headers: { Accept: 'application/json', 'User-Agent': this._ua } });
    const json = await r.json().catch(() => null);
    // No subtitles for it is a 404 with a message, not a failure.
    if (r.status === 404) return [];
    if (!r.ok) throw failure('Wyzie Subs', json?.message || `answered ${r.status}`, r.status);
    const results = wyzieResultsOf(json);
    for (const x of results) this._links.set(x.fileId, x.url);
    while (this._links.size > 5000) this._links.delete(this._links.keys().next().value);
    return results.map(({ url: _url, ...rest }) => rest);
  }

  async _searchOpenSubtitles({ imdbId, season, episode, isMovie }) {
    const p = new URLSearchParams();
    if (isMovie) p.set('imdb_id', imdbNumber(imdbId));
    else { p.set('parent_imdb_id', imdbNumber(imdbId)); p.set('season_number', String(season)); p.set('episode_number', String(episode)); }
    const languages = this._languages();
    if (languages) p.set('languages', languages);
    return resultsOf(await this._openSubtitles('GET', `${OPENSUBTITLES}/subtitles?${p}`));
  }

  /**
   * The subtitles the chosen site has for a movie or an episode, in the
   * languages set: [{ fileId, language, label, downloads, hearingImpaired,
   * machine, source }]. `imdbId` is the movie's or the show's.
   */
  async search({ imdbId, season = null, episode = null, isMovie = false }) {
    if (!this.configured()) return [];
    const provider = this._provider();
    const key = JSON.stringify([provider, imdbId, isMovie ? null : season, isMovie ? null : episode, this._languages()]);
    const hit = this._searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;
    const q = { imdbId, season, episode, isMovie };
    const results = inOrder(provider === 'wyzie' ? await this._searchWyzie(q) : await this._searchOpenSubtitles(q));
    this._searches.set(key, { results, at: Date.now() });
    if (this._searches.size > 500) this._searches.delete(this._searches.keys().next().value);
    return results;
  }

  _file(fileId) {
    return this._dir ? path.join(this._dir, `${fileId}.srt`) : null;
  }

  _kept(fileId) {
    if (!this._dir) return this._memory.get(fileId) ?? null;
    try { return fs.readFileSync(this._file(fileId), 'utf8'); } catch { return null; }
  }

  _keep(fileId, text) {
    if (!this._dir) { this._memory.set(fileId, text); return; }
    try {
      fs.writeFileSync(this._file(fileId), text, 'utf8');
      // The oldest out once there are too many.
      const files = fs.readdirSync(this._dir).filter((f) => f.endsWith('.srt'))
        .map((f) => ({ f, t: fs.statSync(path.join(this._dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(MAX_FILES)) fs.rmSync(path.join(this._dir, f), { force: true });
    } catch (e) {
      log.warn(TAG, `couldn't keep ${fileId}: ${e.message}`);
    }
  }

  async _downloadWyzie(id) {
    const link = this._links.get(id);
    if (!link) throw Object.assign(new Error('This subtitle has expired — open the subtitles menu again.'), { status: 404 });
    const f = await this._get(link, { headers: { 'User-Agent': this._ua } });
    if (!f.ok) {
      const json = await f.json().catch(() => null);
      throw failure('Wyzie Subs', json?.message || `the file answered ${f.status}`, f.status);
    }
    return decodeSubtitle(await f.arrayBuffer());
  }

  async _downloadOpenSubtitles(id) {
    const login = await this._token().catch((e) => { log.warn(TAG, `login: ${e.message}`); return null; });
    const r = await this._openSubtitles('POST', `${login?.base ?? OPENSUBTITLES}/download`, { body: { file_id: Number(id) }, token: login?.token });
    if (!r?.link) throw failure('OpenSubtitles', r?.message || 'no download link', 502);
    const f = await this._get(r.link);
    if (!f.ok) throw failure('OpenSubtitles', `the file answered ${f.status}`, f.status);
    if (r.remaining != null) log.info(TAG, `OpenSubtitles: ${r.remaining} downloads left today`);
    return decodeSubtitle(await f.arrayBuffer());
  }

  /** A subtitle file as WebVTT, moved by `offset` seconds: kept, or downloaded now. */
  async webVtt(fileId, offset = 0) {
    const id = String(fileId);
    if (!FILE_ID.test(id)) throw Object.assign(new Error('No such subtitle file.'), { status: 404 });
    let text = this._kept(id);
    if (text === null) {
      if (!this._pending.has(id)) {
        this._pending.set(id, (async () => {
          const got = id.startsWith('w') ? await this._downloadWyzie(id) : await this._downloadOpenSubtitles(id);
          this._keep(id, got);
          log.info(TAG, `downloaded ${id}`);
          return got;
        })().finally(() => this._pending.delete(id)));
      }
      text = await this._pending.get(id);
    }
    return toWebVtt(text, Number(offset) || 0);
  }
}

module.exports = { Subtitles, toWebVtt, resultsOf, wyzieResultsOf, decodeSubtitle };
