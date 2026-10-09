// lib/profiles.js
// Server-side profile storage. Each profile holds the portal connection
// details plus per-profile UI preferences (currently: disabledGenres).
//
// Profiles and the "active profile" pointer live on the backend (data/
// profiles.json) so every browser/device talking to this container sees the
// same list — they used to live in each browser's localStorage, which meant
// a laptop and a desktop hitting the same server could show completely
// different profiles.
//
// Consumers that need synchronous access (epgReminders.js, recentlyWatched.js,
// vodProgress.js scope their own localStorage caches by profile id) read from
// an in-memory mirror populated by fetchProfiles(), which App.jsx awaits once
// on startup before rendering. Nothing here touches localStorage except the
// one-time migration below.

import {
  getProfilesRemote, createProfileRemote, updateProfileRemote,
  deleteProfileRemote, setActiveProfileRemote,
} from '../stalkerApi'

// Legacy localStorage keys from before profiles moved server-side.
const LEGACY_PROFILES_KEY = 'stalkerweb_profiles'
const LEGACY_ACTIVE_KEY   = 'stalkerweb_active_profile'
const LEGACY_GENRES_MIGRATED_KEY = 'stalkerweb_genres_migrated'

export const DEFAULT_FORM = {
  name: '',
  portal: '', mac: '', timezone: 'Europe/London', lang: 'en',
  login: '', password: '', token: '', serial_number: '0000000000000',
  device_id: '', device_id2: '', signature: '', portal_signature: '',
  // Whether device_id / device_id2 are actually sent to the portal. STBEmu
  // backups can carry a populated device_id that was never transmitted
  // (send_device_id: false) — importing it verbatim without this flag would
  // send an ID the portal never associated with the account, causing a
  // "device id mismatch". Default true to match prior behavior for
  // manually-created profiles.
  send_device_id: true, send_device_id2: true,
  // STBEmu device (per-profile) — used for the STBEmu backup export
  stb_model: 'MAG250', firmware: '0.2.18-r14-pub-250', custom_firmware: '',
  connection_timeout: 10,
  disabledGenres: [],
}

export function normalizePortal(url) {
  return String(url).trim().replace(/\/c\/?$/, '').replace(/\/?$/, '') + '/c/'
}

// ── In-memory mirror of the server list ──────────────────────────────────────

let _profiles = []
let _activeProfileId = null

// One-time migration: pull any profiles left over in this browser's
// localStorage from before the server-side move into the backend, matching
// on portal+mac so re-running this in a second browser doesn't duplicate
// profiles the first browser already migrated. Safe to call every load —
// it's a no-op once localStorage has nothing left.
async function migrateLegacyLocalProfiles(profiles, activeProfileId) {
  let local
  try { local = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) || '[]') } catch { local = [] }
  if (!Array.isArray(local) || local.length === 0) return { profiles, activeProfileId }

  const existingKeys = new Set(profiles.map(p => `${p.portal}|${p.mac}`))
  const localActiveId = localStorage.getItem(LEGACY_ACTIVE_KEY)
  const localActiveSrc = local.find(p => p.id === localActiveId) || null

  for (const p of local) {
    const key = `${p.portal}|${p.mac}`
    if (!p.portal || !p.mac || existingKeys.has(key)) continue
    try {
      const created = await createProfileRemote(p)
      profiles = [...profiles, created]
      existingKeys.add(key)
    } catch { /* left in localStorage — retried on next load */ }
  }

  if (!activeProfileId && localActiveSrc) {
    const match = profiles.find(p => p.portal === localActiveSrc.portal && p.mac === localActiveSrc.mac)
    if (match) {
      try { await setActiveProfileRemote(match.id); activeProfileId = match.id } catch { /* best effort */ }
    }
  }

  localStorage.removeItem(LEGACY_PROFILES_KEY)
  localStorage.removeItem(LEGACY_ACTIVE_KEY)
  localStorage.removeItem(LEGACY_GENRES_MIGRATED_KEY)
  return { profiles, activeProfileId }
}

// Fetches the profile list from the server, migrates any leftover
// localStorage profiles in, and populates the in-memory mirror. Call once on
// app startup before anything reads getActiveProfileId().
//
// Memoized on an in-flight promise: React 18 StrictMode double-invokes
// mount effects in dev, and App.jsx + SetupPage can both call this during
// the same load — without memoizing, two concurrent calls would each read
// localStorage before either had cleared it and migrate every legacy
// profile twice. A later call (e.g. a fresh /settings mount) gets a fresh
// fetch again once the in-flight one has resolved.
let _fetchPromise = null

export function fetchProfiles() {
  if (_fetchPromise) return _fetchPromise
  _fetchPromise = (async () => {
    try {
      let { profiles, activeProfileId } = await getProfilesRemote()
      ;({ profiles, activeProfileId } = await migrateLegacyLocalProfiles(profiles, activeProfileId))
      _profiles = profiles
      _activeProfileId = activeProfileId
      return { profiles, activeProfileId }
    } finally {
      _fetchPromise = null
    }
  })()
  return _fetchPromise
}

export function getCachedProfiles() {
  return _profiles
}

// ── Active profile pointer ───────────────────────────────────────────────────

export function getActiveProfileId() {
  return _activeProfileId
}

export async function setActiveProfile(id) {
  await setActiveProfileRemote(id || null)
  _activeProfileId = id || null
}

export function getActiveProfile() {
  return _profiles.find(p => p.id === _activeProfileId) || null
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createProfile(profile) {
  const created = await createProfileRemote(profile)
  _profiles = [created, ..._profiles]
  return created
}

export async function updateProfile(id, patch) {
  const updated = await updateProfileRemote(id, patch)
  _profiles = _profiles.map(p => p.id === id ? updated : p)
  return _profiles
}

export async function deleteProfile(id) {
  await deleteProfileRemote(id)
  _profiles = _profiles.filter(p => p.id !== id)
  if (_activeProfileId === id) _activeProfileId = null
  return _profiles
}
