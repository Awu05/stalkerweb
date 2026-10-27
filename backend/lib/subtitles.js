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

const crypto = require('crypto');
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

const BOM = String.fromCharCode(0xfeff);

/**
 * An SRT (or WebVTT) file as WebVTT, every cue moved by `offset` seconds.
 * Cues moved before the start are dropped; styling tags SRT files carry from
 * ASS ("{\an8}") are taken out.
 */
function toWebVtt(text, offset = 0) {
  let src = String(text || '').replace(/\r\n?/g, '\n');
  if (src.startsWith(BOM)) src = src.slice(1);
  const out = ['WEBVTT', ''];
  // Cues are parted by a blank line — which may hold spaces or tabs.
  for (const block of src.split(/\n(?:[ \t]*\n)+/)) {
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

// The older, one-byte encodings files in these languages come in.
const LEGACY_ENCODING = {
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251', be: 'windows-1251',
  ar: 'windows-1256', fa: 'windows-1256', el: 'windows-1253', he: 'windows-1255', tr: 'windows-1254',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250', hr: 'windows-1250', sl: 'windows-1250', bs: 'windows-1250',
  th: 'windows-874', vi: 'windows-1258', lt: 'windows-1257', lv: 'windows-1257', et: 'windows-1257',
};

// "CP1251", "Windows-1251", "UTF-8" → a TextDecoder label, or null.
function encodingLabel(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const label = /^cp-?(\d{3,4})$/.test(n) ? `windows-${n.replace(/\D/g, '')}` : n;
  try { new globalThis.TextDecoder(label); return label; } catch { return null; }
}

/**
 * A downloaded file as text: UTF-16 by its byte-order mark, else UTF-8, else
 * the encoding the site says it's in, else the usual older one for its
 * language (Windows-1251 for Russian…), else Windows-1252.
 */
function decodeSubtitle(buf, { language = '', encoding = '' } = {}) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new globalThis.TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new globalThis.TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* an older encoding */ }
  const said = encodingLabel(encoding);
  const lang = String(language || '').toLowerCase().split(/[-_]/)[0];
  const label = said && said !== 'utf-8' ? said : LEGACY_ENCODING[lang] || 'windows-1252';
  return new globalThis.TextDecoder(label).decode(bytes);
}

// The status a failed lookup is answered with: the daily limit as itself, the
// rest a bad gateway. `upstream` is the site's own status.
const failure = (site, why, status) =>
  Object.assign(new Error(`${site}: ${why}`), { status: status === 406 || status === 429 ? 429 : 502, upstream: status });

const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ── Wyzie Subs ───────────────────────────────────────────────────────────────
// sub.wyzie.io: subtitle sites behind codenames, searched by IMDb id, with a
// free key (1,000 requests a day — a search is one, each file one more). Its
// file links carry a token, so they're kept on the server with the search, and
// the players get our own id for each.

const WYZIE = 'https://sub.wyzie.io';

/** Wyzie's sources (docs.wyzie.io/subs/sources): which a free key may search, and what each is for. */
const WYZIE_SOURCES = [
  { id: 'charlie', free: true, note: '' },
  { id: 'lima', free: true, note: '' },
  { id: 'india', free: false, note: '' },
  { id: 'foxtrot', free: false, note: 'anime' },
  { id: 'juliet', free: false, note: 'anime' },
  { id: 'mike', free: false, note: 'anime' },
];
const DEFAULT_WYZIE_SOURCES = ['charlie'];

/** The sources chosen in Settings, as Wyzie takes them: known ones only, charlie when none. */
function wyzieSourcesOf(list) {
  const known = new Set(WYZIE_SOURCES.map((s) => s.id));
  const picked = (Array.isArray(list) ? list : String(list || '').split(','))
    .map((s) => String(s).trim().toLowerCase()).filter((s) => known.has(s));
  return picked.length ? [...new Set(picked)] : DEFAULT_WYZIE_SOURCES;
}

/**
 * Wyzie's search answer as the players list it: each with an id of our own
 * ("w" and a hash of its source, id and link — two results never share one),
 * the link and encoding kept apart.
 */
function wyzieResultsOf(body) {
  const seen = new Set();
  const list = [];
  for (const r of Array.isArray(body) ? body : []) {
    if (!/^https:\/\//.test(r?.url || '')) continue;
    const fileId = `w${shortHash(`${r.source ?? ''}|${r.id ?? ''}|${String(r.url).split('?')[0]}`)}`;
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    list.push({
      fileId,
      url: r.url,
      encoding: String(r.encoding || ''),
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
  const seen = new Set();
  const list = [];
  for (const d of Array.isArray(body?.data) ? body.data : []) {
    const a = d?.attributes ?? {};
    const file = Array.isArray(a.files) ? a.files[0] : null;
    if (!file?.file_id || seen.has(String(file.file_id))) continue;
    seen.add(String(file.file_id));
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

// A subtitle file's id: OpenSubtitles' number, or "w" and our hash for Wyzie's.
const FILE_ID = /^(?:\d{1,12}|w[0-9a-f]{16})$/;
const MAX_KNOWN = 20000;

class Subtitles {
  /**
   * @param {string|null} dir  where downloaded files are kept; null: in memory.
   * @param {{ settings: () => { provider, wyzieKey, wyzieSources, apiKey, username, password, languages }, userAgent?: string, fetch?: Function }} opts
   *   provider 'wyzie' (the default) or 'opensubtitles'; apiKey, username and password are OpenSubtitles'.
   */
  constructor(dir, { settings, userAgent = 'StalkerWeb', fetch: fetchFn = globalThis.fetch }) {
    this._dir = dir;
    this._settings = settings;
    this._ua = userAgent;
    this._fetch = fetchFn;
    this._searches = new Map();   // key → { results, at }
    // The files the server's own searches found — the only ones it fetches
    // (a playback-token holder can't spend the account's downloads on others).
    // A Wyzie file's entry is its link and encoding.
    this._known = new Map();      // fileId → { url?, encoding?, language }
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

  _remember(results) {
    for (const r of results) {
      // Newest last, so the oldest go first.
      this._known.delete(r.fileId);
      this._known.set(r.fileId, { url: r.url, encoding: r.encoding, language: r.language });
    }
    while (this._known.size > MAX_KNOWN) this._known.delete(this._known.keys().next().value);
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
    const ask = async (sources) => {
      const p = new URLSearchParams({ id: imdbId, format: 'srt', source: sources.join(',') });
      if (!isMovie) { p.set('season', String(season)); p.set('episode', String(episode)); }
      const languages = this._languages();
      if (languages) p.set('language', languages);
      p.set('key', this._settings().wyzieKey);
      const r = await this._get(`${WYZIE}/search?${p}`, { headers: { Accept: 'application/json', 'User-Agent': this._ua } });
      return { r, json: await r.json().catch(() => null) };
    };
    const sources = wyzieSourcesOf(this._settings().wyzieSources);
    let { r, json } = await ask(sources);
    // A free key asking a Pro source: charlie alone, rather than nothing.
    if (r.status === 403 && sources.join() !== DEFAULT_WYZIE_SOURCES.join()) {
      log.warn(TAG, `Wyzie: ${json?.message || 'refused'} for ${sources.join(', ')} — searching ${DEFAULT_WYZIE_SOURCES.join(', ')} only`);
      ({ r, json } = await ask(DEFAULT_WYZIE_SOURCES));
    }
    // No subtitles for it is a 404 with a message, not a failure.
    if (r.status === 404) return [];
    if (!r.ok) throw failure('Wyzie Subs', json?.message || `answered ${r.status}`, r.status);
    return wyzieResultsOf(json);
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
    const sources = provider === 'wyzie' ? wyzieSourcesOf(this._settings().wyzieSources).join(',') : '';
    const key = JSON.stringify([provider, sources, imdbId, isMovie ? null : season, isMovie ? null : episode, this._languages()]);
    const hit = this._searches.get(key);
    // Kept, unless a file of it has been forgotten since (it couldn't be fetched).
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS && hit.ids.every((id) => this._known.has(id) || this._kept(id) !== null)) return hit.results;
    const q = { imdbId, season, episode, isMovie };
    const found = inOrder(provider === 'wyzie' ? await this._searchWyzie(q) : await this._searchOpenSubtitles(q));
    this._remember(found);
    const results = found.map(({ url: _url, encoding: _enc, ...rest }) => rest);
    this._searches.delete(key);
    this._searches.set(key, { results, ids: results.map((r) => r.fileId), at: Date.now() });
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

  async _downloadWyzie(id, known) {
    const f = await this._get(known.url, { headers: { 'User-Agent': this._ua } });
    if (!f.ok) {
      const json = await f.json().catch(() => null);
      throw failure('Wyzie Subs', json?.message || `the file answered ${f.status}`, f.status);
    }
    return decodeSubtitle(await f.arrayBuffer(), known);
  }

  async _downloadOpenSubtitles(id, known) {
    const once = async (login) => {
      const r = await this._openSubtitles('POST', `${login?.base ?? OPENSUBTITLES}/download`, { body: { file_id: Number(id) }, token: login?.token });
      if (!r?.link) throw failure('OpenSubtitles', r?.message || 'no download link', 502);
      return r;
    };
    let login = await this._token().catch((e) => { log.warn(TAG, `login: ${e.message}`); return null; });
    let r;
    try {
      r = await once(login);
    } catch (e) {
      // The login no longer counts (signed out elsewhere): sign in again, once.
      if (!login || e.upstream !== 401) throw e;
      this._login = null;
      login = await this._token().catch(() => null);
      r = await once(login);
    }
    const f = await this._get(r.link);
    if (!f.ok) throw failure('OpenSubtitles', `the file answered ${f.status}`, f.status);
    if (r.remaining != null) log.info(TAG, `OpenSubtitles: ${r.remaining} downloads left today`);
    return decodeSubtitle(await f.arrayBuffer(), known);
  }

  /**
   * A subtitle file as WebVTT, moved by `offset` seconds: kept, or — one a
   * search here found — downloaded now.
   */
  async webVtt(fileId, offset = 0) {
    const id = String(fileId);
    if (!FILE_ID.test(id)) throw Object.assign(new Error('No such subtitle file.'), { status: 404 });
    let text = this._kept(id);
    if (text === null) {
      const known = this._known.get(id);
      if (!known || (id.startsWith('w') && !known.url)) {
        throw Object.assign(new Error('This subtitle is no longer listed — open the subtitles menu again.'), { status: 404 });
      }
      if (!this._pending.has(id)) {
        this._pending.set(id, (async () => {
          try {
            const got = id.startsWith('w') ? await this._downloadWyzie(id, known) : await this._downloadOpenSubtitles(id, known);
            this._keep(id, got);
            log.info(TAG, `downloaded ${id}`);
            return got;
          } catch (e) {
            // A file the site no longer gives (an expired link, a removed file) is
            // forgotten, so the search it came from is asked again rather than kept.
            // The daily limit isn't the file's fault: it stays.
            if (e.status !== 429) this._known.delete(id);
            throw e;
          }
        })().finally(() => this._pending.delete(id)));
      }
      text = await this._pending.get(id);
    }
    return toWebVtt(text, Number(offset) || 0);
  }
}

module.exports = { Subtitles, toWebVtt, resultsOf, wyzieResultsOf, decodeSubtitle, wyzieSourcesOf, WYZIE_SOURCES, DEFAULT_WYZIE_SOURCES };
