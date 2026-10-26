'use strict';

// Numeric ids for series episodes served through the Xtream API.
//
// An Xtream episode is played as /series/<user>/<pass>/<id>.<ext> — one number.
// A portal episode needs four values to play (show id, season id, episode id,
// episode number), so each episode is given a small integer the first time it
// is listed, and the mapping is kept on disk so the ids stay valid across
// restarts (clients such as Jellyfin cache them).

const fs = require('fs');
const { writeJsonAtomic, DebouncedSave } = require('./jsonFile');
const TAG = 'xtream';

class XtreamIdStore {
  /** @param {string|null} file  JSON file to persist to; null keeps ids in memory only. */
  constructor(file) {
    this._file   = file;
    this._byKey  = new Map();
    this._byId   = new Map();
    this._next   = 1;
    this._saver  = new DebouncedSave(() => writeJsonAtomic(this._file, { next: this._next, byKey: Object.fromEntries(this._byKey) }), { tag: TAG });
    this._load();
  }

  _load() {
    if (!this._file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      for (const [key, id] of Object.entries(saved.byKey || {})) this._index(key, id);
      this._next = Math.max(this._next, Number(saved.next) || 1);
    } catch { /* first run, or unreadable — start fresh */ }
  }

  _index(key, id) {
    this._byKey.set(key, id);
    this._byId.set(id, key);
    if (id >= this._next) this._next = id + 1;
  }

  _scheduleSave() {
    if (this._file) this._saver.schedule();
  }

  /** Writes any unsaved ids now. Called on shutdown so none are lost. */
  flush() {
    if (this._file) this._saver.flush();
  }

  /**
   * The id for an episode, assigning one the first time it is seen. `portal`
   * is part of the key: the same show/season/episode ids on another portal
   * are a different episode.
   */
  idFor({ portal = '', showId, seasonId = '', episodeId = '', series = 0 }) {
    const key = JSON.stringify([String(portal), String(showId), String(seasonId), String(episodeId), Number(series) || 0]);
    let id = this._byKey.get(key);
    if (id === undefined) {
      id = this._next;
      this._index(key, id);
      this._scheduleSave();
    }
    return id;
  }

  /** The episode behind an id, or null. */
  get(id) {
    const key = this._byId.get(Number(id));
    if (!key) return null;
    const [portal, showId, seasonId, episodeId, series] = JSON.parse(key);
    return { portal, showId, seasonId, episodeId, series };
  }
}

module.exports = XtreamIdStore;
