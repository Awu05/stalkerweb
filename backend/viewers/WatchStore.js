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
// `episodes` too: some portals mark a show only by its episode list.
const LIST_FIELDS = ['id', 'name', 'year', 'isHD', 'isSeries', 'episodes', 'genres', 'rating', 'added', 'durationMin',
  'screenshotUrl', 'cmd', 'description', 'director', 'actors'];
const listItem = (item) => Object.fromEntries(LIST_FIELDS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));

const empty = () => ({ progress: [], history: [], watched: [], list: [] });
const titleIdOf = (key) => String(key).split(':')[0];

class WatchStore {
  constructor(dataDir) {
    this._dir = dataDir;
    this._file = path.join(dataDir, 'watch.json');
  }

  // The file is read again only when it changed on disk (by mtime and size),
  // not on every request — progress saves come every few seconds.
  _load() {
    let st;
    try { st = fs.statSync(this._file); } catch { this._cache = null; return {}; }
    if (this._cache && this._cache.mtimeMs === st.mtimeMs && this._cache.size === st.size) return this._cache.data;
    try {
      const d = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      const data = d && typeof d === 'object' ? d : {};
      this._cache = { mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    } catch {
      this._cache = null;
      return {};
    }
  }

  _save(d) {
    delete d.__adopted;   // _bucket's note to get(), not data
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
      fs.renameSync(tmp, this._file);
      const st = fs.statSync(this._file);
      this._cache = { mtimeMs: st.mtimeMs, size: st.size, data: d };
    } catch (e) {
      this._cache = null;   // what's in memory may now differ from the file
      log.error(TAG, `save failed: ${e.message}`);
      throw e;
    }
  }

  // A viewer's lists on one portal, created when asked for with `create`.
  // Entries kept under no portal — old Continue Watching entries saved before
  // the portal was recorded — go to the first portal this viewer uses, merged
  // under what's there (its own entries win). Returns whether any moved.
  _adoptOrphans(d, viewerId, p) {
    const orphans = p ? d[viewerId]?.[''] : null;
    if (!orphans) return false;
    delete d[viewerId][''];
    const b = this._bucket(d, viewerId, p, true);
    const list = (k) => (Array.isArray(orphans[k]) ? orphans[k] : []);
    const keys = new Set(b.progress.map((e) => e.key));
    b.progress = [...b.progress, ...list('progress').filter((e) => !keys.has(e.key))].slice(0, PROGRESS_MAX);
    const ids = new Set(b.history.map((e) => e.id));
    b.history = [...b.history, ...list('history').filter((e) => !ids.has(e.id))].slice(0, HISTORY_MAX);
    b.watched = [...new Set([...b.watched, ...list('watched')])].slice(0, WATCHED_MAX);
    const saved = new Set(b.list.map((e) => e.id));
    b.list = [...b.list, ...list('list').filter((e) => !saved.has(e.id))].slice(0, LIST_MAX);
    log.info(TAG, `moved ${viewerId}'s entries with no portal to ${p}`);
    return true;
  }

  _bucket(d, viewerId, portal, create = false) {
    const p = String(portal || '');
    if (this._adoptOrphans(d, viewerId, p)) d.__adopted = true;
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
    const d = this._load();
    const b = this._bucket(d, viewerId, portal);
    if (d.__adopted) {
      delete d.__adopted;
      try { this._save(d); } catch { /* moved again on the next read */ }
    }
    return b;
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
