'use strict';

// ProfilesManager — persists portal connection profiles to data/profiles.json.
// Profiles used to live in the browser's localStorage, which meant every
// browser/device had its own disjoint list. Moving them server-side (same
// pattern as FavoritesManager) makes the profile list — and which one is
// "active" — consistent across every client that talks to this container.

const fs   = require('fs');
const path = require('path');
const log  = require('../logger');
const TAG  = 'ProfilesManager';

function genId() {
  return `prof_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

class ProfilesManager {
  constructor(dataDir) {
    this._file = path.join(dataDir, 'profiles.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      return {
        profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
        activeProfileId: raw.activeProfileId || null,
      };
    } catch {
      return { profiles: [], activeProfileId: null };
    }
  }

  _save(data) {
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log.error(TAG, `save failed: ${e.message}`);
    }
  }

  list() {
    const d = this._load();
    return { profiles: d.profiles, activeProfileId: d.activeProfileId };
  }

  get(id) {
    return this._load().profiles.find(p => p.id === id) || null;
  }

  /** The profile currently marked active, or null. */
  getActive() {
    const d = this._load();
    return d.activeProfileId ? d.profiles.find(p => p.id === d.activeProfileId) || null : null;
  }

  // Accepts a client-supplied id (used when migrating existing localStorage
  // profiles in so their ids — and any active-profile pointer keyed on
  // them — stay valid) or generates one.
  create(profile) {
    const d  = this._load();
    const id = profile.id && !d.profiles.some(p => p.id === profile.id) ? profile.id : genId();
    const saved = { ...profile, id };
    d.profiles.push(saved);
    this._save(d);
    return saved;
  }

  update(id, patch) {
    const d   = this._load();
    const idx = d.profiles.findIndex(p => p.id === id);
    if (idx === -1) return null;
    d.profiles[idx] = { ...d.profiles[idx], ...patch, id };
    this._save(d);
    return d.profiles[idx];
  }

  remove(id) {
    const d = this._load();
    const before = d.profiles.length;
    d.profiles = d.profiles.filter(p => p.id !== id);
    if (d.activeProfileId === id) d.activeProfileId = null;
    this._save(d);
    return d.profiles.length !== before;
  }

  setActive(id) {
    const d = this._load();
    if (id && !d.profiles.some(p => p.id === id)) return false;
    d.activeProfileId = id || null;
    this._save(d);
    return true;
  }
}

module.exports = ProfilesManager;
