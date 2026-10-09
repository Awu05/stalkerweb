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

class ViewerError extends Error {
  constructor(status, message) {
    super(message);
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

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      const viewers = Array.isArray(raw.viewers) ? raw.viewers.filter((v) => v && typeof v.id === 'string') : [];
      const defaultViewerId = viewers.some((v) => v.id === raw.defaultViewerId) ? raw.defaultViewerId : (viewers[0]?.id ?? null);
      return { defaultViewerId, viewers };
    } catch {
      return { defaultViewerId: null, viewers: [] };
    }
  }

  _save(data) {
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log.error(TAG, `save failed: ${e.message}`);
      throw e;
    }
  }

  // The data, never without a viewer: a missing or emptied file gets a Default.
  _data() {
    const d = this._load();
    if (d.viewers.length) return d;
    const v = blankViewer('Default', COLORS[0]);
    const fresh = { defaultViewerId: v.id, viewers: [v] };
    this._save(fresh);
    return fresh;
  }

  _mutate(id, change) {
    const d = this._data();
    const v = d.viewers.find((x) => x.id === id);
    if (!v) throw new ViewerError(404, 'Viewer not found.');
    change(v, d);
    this._save(d);
    return v;
  }

  _checkName(d, name, exceptId = null) {
    const n = String(name ?? '').trim();
    if (!n || n.length > MAX_NAME) throw new ViewerError(400, `A name of 1–${MAX_NAME} characters is required.`);
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

  /** A viewer by name or id, ignoring case (Xtream usernames), or null. */
  findByName(nameOrId) {
    const n = String(nameOrId ?? '').trim().toLowerCase();
    if (!n) return null;
    return this._data().viewers.find((v) => v.id.toLowerCase() === n || v.name.toLowerCase() === n) || null;
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
      if (name !== undefined) v.name = this._checkName(d, name, id);
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
