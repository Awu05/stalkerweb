'use strict';

// Saving a store's JSON file: whole, through a temporary file renamed over
// the old one (a crash mid-write never leaves half a file), and — for stores
// that change often — a second after the last change, not on every one.

const fs = require('fs');
const log = require('../logger');

/** Writes `data` as JSON to `file`, atomically. Throws when it can't. */
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * A save made `delayMs` after the first change asked for it. `save()` writes
 * what the store holds then; a failed write is logged and tried again on the
 * next change or flush. `flush()` writes a waiting save now (on shutdown).
 */
class DebouncedSave {
  constructor(save, { delayMs = 1000, tag = 'store' } = {}) {
    this._save = save;
    this._delayMs = delayMs;
    this._tag = tag;
    this._timer = null;
    this._dirty = false;
  }

  schedule() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), this._delayMs);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    try {
      this._save();
      this._dirty = false;
    } catch (e) {
      log.error(this._tag, `save failed: ${e.message}`);
    }
  }
}

module.exports = { writeJsonAtomic, DebouncedSave };
