'use strict';

// Subtitles from OpenSubtitles (api.opensubtitles.com), for the VOD players'
// subtitle menu — next to the ones in the video itself, which the players
// read on their own.
//
// OpenSubtitles needs an API key (free, from an opensubtitles.com account,
// Settings → Playback); an account's username and password add more downloads
// a day (5 a day without, 20 with a free account). Titles are found by IMDb
// id — the one skip intro already matched (lib/skipSegments.js).
//
// A downloaded file is kept on disk, so playing it again (or on another
// device, or with another delay) costs no download. It's served as WebVTT —
// what both the browser and the apps' player take — with the viewer's delay
// applied (`offset`, seconds: + later, − earlier).

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const TAG = 'subtitles';

const API = 'https://api.opensubtitles.com/api/v1';
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

// ── OpenSubtitles ───────────────────────────────────────────────────────────

const imdbNumber = (id) => String(id || '').replace(/^tt/, '').replace(/^0+/, '');

/** OpenSubtitles' search answer as the players list it, most downloaded first. */
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
    });
  }
  return list.sort((x, y) => x.language.localeCompare(y.language) || Number(x.machine) - Number(y.machine) || y.downloads - x.downloads);
}

class Subtitles {
  /**
   * @param {string|null} dir  where downloaded files are kept; null: in memory.
   * @param {{ settings: () => { apiKey, username, password, languages }, userAgent?: string, fetch?: Function }} opts
   */
  constructor(dir, { settings, userAgent = 'StalkerWeb', fetch: fetchFn = globalThis.fetch }) {
    this._dir = dir;
    this._settings = settings;
    this._ua = userAgent;
    this._fetch = fetchFn;
    this._searches = new Map();   // key → { results, at }
    this._memory = new Map();     // fileId → text (no dir)
    this._login = null;           // { key, token, base, at }
    this._pending = new Map();    // fileId → a download under way
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  /** Whether an API key is set (the players offer online subtitles only then). */
  configured() {
    return !!this._settings().apiKey;
  }

  async _call(method, url, { body, token } = {}) {
    const { apiKey } = this._settings();
    const r = await this._fetch(url, {
      method,
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Api-Key': apiKey,
        'User-Agent': this._ua,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) {
      const why = json?.message || json?.errors?.[0] || `answered ${r.status}`;
      throw Object.assign(new Error(`OpenSubtitles: ${why}`), { status: r.status === 401 || r.status === 403 ? 502 : r.status === 406 || r.status === 429 ? 429 : 502 });
    }
    return json;
  }

  // The account's login, when one is set: more downloads a day. Kept for a while.
  async _token() {
    const { apiKey, username, password } = this._settings();
    if (!username || !password) return null;
    const key = `${apiKey}|${username}|${password}`;
    if (this._login?.key === key && Date.now() - this._login.at < TOKEN_TTL_MS) return this._login;
    const r = await this._call('POST', `${API}/login`, { body: { username, password } });
    const base = r?.base_url ? `https://${String(r.base_url).replace(/^https?:\/\//, '')}/api/v1` : API;
    this._login = { key, token: r?.token || null, base, at: Date.now() };
    return this._login;
  }

  /**
   * The subtitles OpenSubtitles has for a movie or an episode, in the
   * languages chosen in Settings: [{ fileId, language, label, downloads,
   * hearingImpaired, machine }]. `imdbId` is the movie's or the show's.
   */
  async search({ imdbId, season = null, episode = null, isMovie = false }) {
    if (!this.configured()) return [];
    const languages = String(this._settings().languages || '').toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(',');
    const p = new URLSearchParams();
    if (isMovie) p.set('imdb_id', imdbNumber(imdbId));
    else { p.set('parent_imdb_id', imdbNumber(imdbId)); p.set('season_number', String(season)); p.set('episode_number', String(episode)); }
    if (languages) p.set('languages', languages);
    const key = p.toString();
    const hit = this._searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;
    const results = resultsOf(await this._call('GET', `${API}/subtitles?${key}`));
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

  /** A subtitle file as WebVTT, moved by `offset` seconds: kept, or downloaded now. */
  async webVtt(fileId, offset = 0) {
    const id = String(fileId);
    if (!/^\d{1,12}$/.test(id)) throw Object.assign(new Error('No such subtitle file.'), { status: 404 });
    let text = this._kept(id);
    if (text === null) {
      if (!this.configured()) throw Object.assign(new Error('OpenSubtitles is not set up (Settings → Playback).'), { status: 404 });
      if (!this._pending.has(id)) {
        this._pending.set(id, (async () => {
          const login = await this._token().catch((e) => { log.warn(TAG, `login: ${e.message}`); return null; });
          const r = await this._call('POST', `${login?.base ?? API}/download`, { body: { file_id: Number(id) }, token: login?.token });
          if (!r?.link) throw Object.assign(new Error(`OpenSubtitles: ${r?.message || 'no download link'}`), { status: 502 });
          const f = await this._fetch(r.link, { signal: globalThis.AbortSignal.timeout(TIMEOUT_MS) });
          if (!f.ok) throw Object.assign(new Error(`OpenSubtitles: the file answered ${f.status}`), { status: 502 });
          const got = await f.text();
          this._keep(id, got);
          log.info(TAG, `downloaded ${id}${r.remaining != null ? ` (${r.remaining} downloads left today)` : ''}`);
          return got;
        })().finally(() => this._pending.delete(id)));
      }
      text = await this._pending.get(id);
    }
    return toWebVtt(text, Number(offset) || 0);
  }
}

module.exports = { Subtitles, toWebVtt, resultsOf };
