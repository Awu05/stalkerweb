'use strict';

// WatchStore — what each viewer has watched on the VOD page, per portal, in
// data/watch.json, so it follows the viewer to any device:
//   progress: resume points, one per movie or episode (newest first)
//   history:  the last titles played, a show once with the episode played last,
//             finished ones included — the VOD page's "Recently watched" row
//   watched:  ids of titles finished, for the "Not watched" filter
//   list:     My List — titles saved to watch later, newest first; each moves
//             to Completed (completedAt) when finished: a movie at its end, a
//             show at its last episode — or by hand
// Ids are the portal's own, meaningless on another portal — hence per portal.

const fs   = require('fs');
const path = require('path');
const log  = require('../logger');
const TAG  = 'WatchStore';

// Mirrors frontend/src/lib/vodProgress.js.
const RESUME_MIN_SECS = 30;    // less is "only just started"
const DONE_FRACTION   = 0.95;  // more is finished
const PROGRESS_MAX = 50;
const HISTORY_MAX  = 20;
const WATCHED_MAX  = 2000;
const LIST_MAX     = 500;

// What My List keeps of a title: enough to show its tile, filter it and play
// it, without asking the portal again.
const LIST_FIELDS = ['id', 'name', 'year', 'isHD', 'isSeries', 'genres', 'rating', 'added', 'durationMin',
  'screenshotUrl', 'cmd', 'description', 'director', 'actors'];
const listItem = (item) => Object.fromEntries(LIST_FIELDS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));

const empty = () => ({ progress: [], history: [], watched: [], list: [] });
const titleIdOf = (key) => String(key).split(':')[0];

class WatchStore {
  constructor(dataDir) {
    this._dir = dataDir;
    this._file = path.join(dataDir, 'watch.json');
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      return d && typeof d === 'object' ? d : {};
    } catch {
      return {};
    }
  }

  _save(d) {
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log.error(TAG, `save failed: ${e.message}`);
      throw e;
    }
  }

  // A viewer's lists on one portal, created when asked for with `create`.
  _bucket(d, viewerId, portal, create = false) {
    const p = String(portal || '');
    if (!d[viewerId]?.[p]) {
      if (!create) return empty();
      d[viewerId] ??= {};
      d[viewerId][p] = empty();
    }
    const b = d[viewerId][p];
    for (const k of ['progress', 'history', 'watched', 'list']) if (!Array.isArray(b[k])) b[k] = [];
    return b;
  }

  get(viewerId, portal) {
    return this._bucket(this._load(), viewerId, portal);
  }

  _apply(b, entry, updatedAt) {
    const key = String(entry.key);
    const id = titleIdOf(key);
    const position = Number(entry.position) || 0;
    const duration = Number(entry.duration) || 0;
    const finished = duration > 0 && position / duration >= DONE_FRACTION;
    const started = position >= RESUME_MIN_SECS;
    const info = {
      title: String(entry.title ?? ''),
      episodeTitle: entry.episodeTitle ? String(entry.episodeTitle) : '',
      screenshotUrl: String(entry.screenshotUrl ?? ''),
      params: String(entry.params ?? ''),
    };

    b.progress = b.progress.filter((e) => e.key !== key);
    if (started && !finished) b.progress.unshift({ key, ...info, position, duration, updatedAt });
    b.progress = b.progress.slice(0, PROGRESS_MAX);

    if (started || finished) {
      b.history = [{ id, key, ...info, position, duration, finished, updatedAt }, ...b.history.filter((e) => e.id !== id)].slice(0, HISTORY_MAX);
    }
    if (finished) b.watched = [id, ...b.watched.filter((x) => x !== id)].slice(0, WATCHED_MAX);

    // My List: a movie is done at its end; a show at its last episode (the
    // player says so — it knows the show's seasons).
    const done = finished && (!key.includes(':') || entry.lastEpisode === true);
    const saved = b.list.find((e) => e.id === id);
    if (done && saved && !saved.completedAt) saved.completedAt = updatedAt;
  }

  /** A title onto My List (once; already there, it stays where it is). */
  addToList(viewerId, portal, item) {
    if (!item?.id) return this.get(viewerId, portal);
    const d = this._load();
    const b = this._bucket(d, viewerId, portal, true);
    const id = String(item.id);
    if (!b.list.some((e) => e.id === id)) {
      b.list = [{ id, item: { ...listItem(item), id }, addedAt: Date.now(), completedAt: null }, ...b.list].slice(0, LIST_MAX);
      this._save(d);
    }
    return b;
  }

  removeFromList(viewerId, portal, id) {
    const d = this._load();
    const b = this._bucket(d, viewerId, portal, true);
    b.list = b.list.filter((e) => e.id !== String(id));
    this._save(d);
    return b;
  }

  /** Moved to Completed, or back to To watch. */
  setListCompleted(viewerId, portal, id, completed) {
    const d = this._load();
    const b = this._bucket(d, viewerId, portal, true);
    const e = b.list.find((x) => x.id === String(id));
    if (e) { e.completedAt = completed ? Date.now() : null; this._save(d); }
    return b;
  }

  /**
   * A position reached in a movie or episode: { key, title, episodeTitle?,
   * screenshotUrl, params, position, duration }. A title only just started
   * isn't recorded; one finished leaves no resume point but stays in the
   * history and is marked watched. Returns the viewer's lists.
   */
  record(viewerId, portal, entry) {
    if (!entry?.key) return this.get(viewerId, portal);
    const d = this._load();
    const b = this._bucket(d, viewerId, portal, true);
    this._apply(b, entry, Date.now());
    this._save(d);
    return b;
  }

  /** A title out of the history, with its resume points. */
  removeTitle(viewerId, portal, titleId) {
    const d = this._load();
    const b = this._bucket(d, viewerId, portal, true);
    const id = String(titleId);
    b.history = b.history.filter((e) => e.id !== id);
    b.progress = b.progress.filter((e) => titleIdOf(e.key) !== id);
    this._save(d);
    return b;
  }

  /** The history emptied; resume points and what was watched are kept. */
  clearHistory(viewerId, portal) {
    const d = this._load();
    const b = this._bucket(d, viewerId, portal, true);
    b.history = [];
    this._save(d);
    return b;
  }

  /**
   * First start with this store: the old shared Continue Watching list
   * (vod-progress.json, from before viewers) goes to the default viewer. The
   * old file is left in place. Returns whether it ran.
   */
  importLegacy(viewerId) {
    if (fs.existsSync(this._file)) return false;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(this._dir, 'vod-progress.json'), 'utf8')); } catch { /* none */ }
    const d = {};
    if (Array.isArray(list)) {
      for (const e of [...list].reverse()) {   // oldest first, so the newest ends up on top
        if (!e?.key) continue;
        this._apply(this._bucket(d, viewerId, e.portal, true), e, Number(e.updatedAt) || Date.now());
      }
    }
    this._save(d);
    if (list.length) log.info(TAG, `moved ${list.length} Continue Watching entr${list.length === 1 ? 'y' : 'ies'} to the default viewer`);
    return true;
  }
}

module.exports = WatchStore;
