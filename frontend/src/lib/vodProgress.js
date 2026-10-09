// Persisted "Continue Watching" progress for VOD movies and series episodes.
// localStorage is the fast/synchronous path; the backend is the source of truth
// for cross-device/cross-browser sync. Both are kept in lock-step:
//   - reads come from localStorage (instant, no await)
//   - writes go to localStorage immediately AND fire-and-forget PUT to backend
//   - syncVodProgressFromBackend() merges the backend list into localStorage;
//     call it once on app load so any progress made on another device appears.

import { getVodProgressBackend, saveVodProgressBackend, removeVodProgressBackend } from '../stalkerApi'
import { getActiveProfileId } from './profiles'

const VOD_PROGRESS_MAX = 20

// Scoped per-profile — same as recentlyWatched.js/epgReminders.js — so
// switching portals doesn't show (or let Resume navigate to) another
// portal's in-progress videoId, which is meaningless outside its own catalog.
function storageKey() {
  const id = getActiveProfileId()
  return id ? `sw_vod_progress_${id}` : 'sw_vod_progress'
}

// Don't offer resume for the first 30s (barely started) or the last 5%
// (effectively finished — clear it instead so it leaves the row).
export const VOD_RESUME_MIN_SECS = 30
export const VOD_DONE_FRACTION   = 0.95

export function getVodProgressList() {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey()) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

// Composite key so a movie and each episode of a series track independently.
export function makeVodKey({ videoId, seasonId = '', episodeId = '' }) {
  return [videoId, seasonId, episodeId].filter(Boolean).join(':')
}

export function getVodProgress(key) {
  return getVodProgressList().find(e => e.key === key) || null
}

export function removeVodProgress(key) {
  const list = getVodProgressList().filter(e => e.key !== key)
  localStorage.setItem(storageKey(), JSON.stringify(list))
  removeVodProgressBackend(key).catch(() => {})
}

// entry: { key, title, episodeTitle, screenshotUrl, position, duration, params }
// Drops the entry (rather than saving) when the title is barely started or
// effectively finished, so the Continue Watching row self-prunes.
export function saveVodProgress(entry) {
  if (!entry?.key || !entry.duration || !isFinite(entry.duration)) return
  const list = getVodProgressList().filter(e => e.key !== entry.key)
  const fraction = entry.position / entry.duration
  if (entry.position < VOD_RESUME_MIN_SECS || fraction >= VOD_DONE_FRACTION) {
    if (fraction >= VOD_DONE_FRACTION) markWatched(entry.key)
    localStorage.setItem(storageKey(), JSON.stringify(list))
    removeVodProgressBackend(entry.key).catch(() => {})
    return
  }
  const withTs = { ...entry, updatedAt: Date.now() }
  const next = [withTs, ...list].slice(0, VOD_PROGRESS_MAX)
  localStorage.setItem(storageKey(), JSON.stringify(next))
  saveVodProgressBackend(withTs).catch(() => {})
}

// ── Watched ───────────────────────────────────────────────────────────────
// Titles finished on this device, by title id (a show by its own id, whichever
// episode was finished), for the VOD page's "Not watched yet" filter. Kept
// apart from the progress list, which drops a title once it is finished.
const WATCHED_MAX = 2000

function watchedKey() {
  const id = getActiveProfileId()
  return id ? `sw_vod_watched_${id}` : 'sw_vod_watched'
}

function readWatched() {
  try {
    const list = JSON.parse(localStorage.getItem(watchedKey()) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function markWatched(key) {
  const id = String(key).split(':')[0]
  if (!id) return
  try {
    const list = [id, ...readWatched().filter((x) => x !== id)].slice(0, WATCHED_MAX)
    localStorage.setItem(watchedKey(), JSON.stringify(list))
  } catch { /* storage full or blocked — not remembered */ }
}

/** Ids of titles started (in Continue Watching) or finished on this device. */
export function getWatchedVodIds() {
  const ids = new Set(readWatched())
  for (const e of getVodProgressList()) ids.add(String(e.key).split(':')[0])
  return ids
}

// Fetch the backend list and merge it into localStorage. Backend entries win
// when the same key exists in both (most-recently-updated takes precedence).
// Call once on app load so progress from other devices/browsers is visible.
export async function syncVodProgressFromBackend() {
  let remote
  try {
    remote = await getVodProgressBackend()
  } catch {
    return // backend unavailable — localStorage already has local progress
  }
  if (!Array.isArray(remote) || remote.length === 0) return

  const local = getVodProgressList()
  const merged = new Map(local.map(e => [e.key, e]))
  for (const re of remote) {
    const le = merged.get(re.key)
    if (!le || (re.updatedAt ?? 0) > (le.updatedAt ?? 0)) {
      merged.set(re.key, re)
    }
  }
  // Re-sort by updatedAt desc and cap
  const sorted = [...merged.values()]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, VOD_PROGRESS_MAX)
  localStorage.setItem(storageKey(), JSON.stringify(sorted))
}
