'use strict';

// ViewersManager — the people who watch on this server, in data/viewers.json.
// Each viewer has their own favorites and their own choice of which channels
// are shown (hidden genres and languages, adult content); every other setting
// is shared. See docs/superpowers/specs/2026-10-08-viewer-profiles-design.md.
//
// Every change reads the file, changes one viewer and writes it back, so two
// viewers saving in turn never overwrite each other.

const fs   = require('fs');
const path = require('path');
const FavoritesManager = require('../favorites/FavoritesManager');
const log  = require('../logger');
const TAG  = 'ViewersManager';

const COLORS   = ['#5b8def', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#978365'];
const MAX_NAME = 30;
const MAX_FORMER_NAMES = 5;   // old names kept for Xtream usernames (findByName)

class ViewerError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ViewerError';
    this.status = status;
  }
}

function genId() {
  return `view_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const strings = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []);

function normalFavorites(f) {
  return {
    channels: strings(f?.channels),
    groups: Array.isArray(f?.groups)
      ? f.groups.filter((g) => g && typeof g.id === 'string').map((g) => ({ ...g, channels: strings(g.channels) }))
      : [],
  };
}

function blankViewer(name, color) {
  return {
    id: genId(),
    name,
    color,
    favorites: { channels: [], groups: [] },
    disabledGenres: [],
    disabledLanguages: [],
    showAdult: false,
  };
}

class ViewersManager {
  constructor(dataDir) {
    this._file = path.join(dataDir, 'viewers.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /**
   * First start after the upgrade: one "Default" viewer made from what used to
   * be shared. Does nothing once viewers.json exists. Returns whether it ran.
   */
  ensureInitialized({ favorites = null, showAdult = false, disabledGenres = [], disabledLanguages = [] } = {}) {
    if (fs.existsSync(this._file)) return false;
    const v = blankViewer('Default', COLORS[0]);
    v.favorites = normalFavorites(favorites);
    v.showAdult = showAdult === true;
    v.disabledGenres = strings(disabledGenres);
    v.disabledLanguages = strings(disabledLanguages);
    this._save({ defaultViewerId: v.id, viewers: [v] });
    log.info(TAG, `created the Default viewer with ${v.favorites.channels.length} favorite(s)`);
    return true;
  }

  // Every request asks who its viewer is, so the parsed file is kept in memory
  // and only read again when its size or modified time changes (a hand edit).
  _load() {
    let stat;
    try {
      stat = fs.statSync(this._file);
    } catch (e) {
      if (e.code === 'ENOENT') return { defaultViewerId: null, viewers: [] };
      return this._unreadable(e);
    }
    const c = this._cache;
    if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.data;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return { defaultViewerId: null, viewers: [] };
      return this._unreadable(e);
    }
    this._warned = false;
    const viewers = Array.isArray(raw?.viewers) ? raw.viewers.filter((v) => v && typeof v.id === 'string') : [];
    // A hand-edited entry may lack a name or carry odd fields: fill in what the
    // rest of the code relies on, so one bad entry can't break every request.
    viewers.forEach((v, i) => {
      if (typeof v.name !== 'string' || !v.name.trim()) v.name = `Viewer ${i + 1}`;
      if (!COLORS.includes(v.color)) v.color = COLORS[i % COLORS.length];
      v.formerNames = strings(v.formerNames);
    });
    const defaultViewerId = viewers.some((v) => v.id === raw?.defaultViewerId) ? raw.defaultViewerId : (viewers[0]?.id ?? null);
    const data = { defaultViewerId, viewers };
    this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  }

  // A viewers.json that exists but can't be read or parsed (a hand edit gone
  // wrong, a file locked by a backup tool) is never overwritten: requests get a
  // temporary Default viewer, and every change is refused until it reads again.
  _unreadable(e) {
    if (!this._warned) {
      log.error(TAG, `viewers.json could not be read (${e.message}) — using a temporary Default viewer and saving nothing until it is fixed`);
      this._warned = true;
    }
    const v = blankViewer('Default', COLORS[0]);
    v.id = 'view_unreadable';
    return { unreadable: true, defaultViewerId: v.id, viewers: [v] };
  }

  _save(data) {
    if (data.unreadable) throw new ViewerError(503, 'viewers.json could not be read, so nothing was saved. Fix or remove the file, then try again.');
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this._file);
      const stat = fs.statSync(this._file);
      this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    } catch (e) {
      this._cache = null;   // the change was made in memory: read the file again
      log.error(TAG, `save failed: ${e.message}`);
      throw e;
    }
  }

  // The data, never without a viewer: a missing or emptied file gets a Default.
  _data() {
    const d = this._load();
    if (d.viewers.length || d.unreadable) return d;
    const v = blankViewer('Default', COLORS[0]);
    const fresh = { defaultViewerId: v.id, viewers: [v] };
    this._save(fresh);
    return fresh;
  }

  _mutate(id, change) {
    const d = this._data();
    const v = d.viewers.find((x) => x.id === id);
    if (!v) throw new ViewerError(404, 'Viewer not found.');
    try {
      change(v, d);
    } catch (e) {
      this._cache = null;   // a change refused halfway must not linger in memory
      throw e;
    }
    this._save(d);
    return v;
  }

  _checkName(d, name, exceptId = null) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.length > MAX_NAME) throw new ViewerError(400, `A name of 1–${MAX_NAME} characters is required.`);
    if (/\p{Cc}/u.test(n)) throw new ViewerError(400, 'A name cannot contain line breaks or control characters.');
    if (d.viewers.some((v) => v.id !== exceptId && v.name.toLowerCase() === n.toLowerCase())) {
      throw new ViewerError(409, `There is already a viewer called "${n}".`);
    }
    return n;
  }

  _checkColor(color, fallback) {
    if (color === undefined) return fallback;
    if (!COLORS.includes(color)) throw new ViewerError(400, 'Pick one of the offered colors.');
    return color;
  }

  list() {
    const d = this._data();
    return { defaultViewerId: d.defaultViewerId, viewers: d.viewers.map(({ id, name, color }) => ({ id, name, color })) };
  }

  get(id) {
    return this._data().viewers.find((v) => v.id === id) || null;
  }

  getDefault() {
    const d = this._data();
    return d.viewers.find((v) => v.id === d.defaultViewerId);
  }

  /**
   * A viewer by name or id, ignoring case (Xtream usernames), or null. A name a
   * viewer had before a rename still finds it, so Xtream apps set up with the
   * old name keep working — unless another viewer now has that name.
   */
  findByName(nameOrId) {
    const n = String(nameOrId ?? '').trim().toLowerCase();
    if (!n) return null;
    const all = this._data().viewers;
    return all.find((v) => v.id.toLowerCase() === n || v.name.toLowerCase() === n)
      || all.find((v) => (v.formerNames ?? []).some((f) => f.toLowerCase() === n))
      || null;
  }

  create({ name, color } = {}) {
    const d = this._data();
    const v = blankViewer(this._checkName(d, name), this._checkColor(color, COLORS[d.viewers.length % COLORS.length]));
    d.viewers.push(v);
    this._save(d);
    return v;
  }

  update(id, { name, color } = {}) {
    return this._mutate(id, (v, d) => {
      if (name !== undefined) {
        const next = this._checkName(d, name, id);
        if (next.toLowerCase() !== v.name.toLowerCase()) {
          v.formerNames = [v.name, ...(v.formerNames ?? []).filter((f) => f.toLowerCase() !== next.toLowerCase())].slice(0, MAX_FORMER_NAMES);
        }
        v.name = next;
      }
      v.color = this._checkColor(color, v.color);
    });
  }

  remove(id) {
    const d = this._data();
    if (!d.viewers.some((v) => v.id === id)) throw new ViewerError(404, 'Viewer not found.');
    if (d.viewers.length === 1) throw new ViewerError(409, 'The last viewer cannot be deleted.');
    d.viewers = d.viewers.filter((v) => v.id !== id);
    if (d.defaultViewerId === id) d.defaultViewerId = d.viewers[0].id;
    this._save(d);
  }

  setFilters(id, { disabledGenres, disabledLanguages, showAdult } = {}) {
    const list = (value, label) => {
      if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) throw new ViewerError(400, `${label} must be a list of names.`);
      return [...new Set(value)];
    };
    if (showAdult !== undefined && typeof showAdult !== 'boolean') throw new ViewerError(400, 'showAdult must be true or false.');
    const genres    = disabledGenres    !== undefined ? list(disabledGenres, 'disabledGenres') : undefined;
    const languages = disabledLanguages !== undefined ? list(disabledLanguages, 'disabledLanguages') : undefined;
    return this._mutate(id, (v) => {
      if (genres) v.disabledGenres = genres;
      if (languages) v.disabledLanguages = languages;
      if (showAdult !== undefined) v.showAdult = showAdult;
    });
  }

  /** The FavoritesManager API, reading and writing this viewer's favorites. */
  favoritesOf(id) {
    const fav = Object.create(FavoritesManager.prototype);
    fav._load = () => normalFavorites(this.get(id)?.favorites);
    fav._save = (f) => { this._mutate(id, (v) => { v.favorites = normalFavorites(f); }); };
    return fav;
  }
}

module.exports = ViewersManager;
module.exports.COLORS = COLORS;
module.exports.ViewerError = ViewerError;
