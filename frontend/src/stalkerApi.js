import { invalidateChannelCache } from './lib/channelCache'
import { invalidateFavoritesCache } from './lib/useFavorites'
import { getViewerId } from './lib/viewer'

const BASE = '/api'
const TIMEOUT_MS = 30_000
export const ACCESS_REQUIRED = 'sw:access-required'
// This device's viewer was deleted on another device: App shows the picker.
export const VIEWER_GONE = 'sw:viewer-gone'

async function _fetch(path, opts = {}) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const viewer = getViewerId()
    const headers = viewer ? { ...opts.headers, 'X-Viewer': viewer } : opts.headers
    const r = await fetch(BASE + path, { ...opts, headers, signal: controller.signal })
    if (!r.ok) {
      const e = await r.json().catch(() => ({ error: r.statusText }))
      // Signed out (ACCESS_KEY set, cookie missing or revoked): App shows the login.
      if (r.status === 401 && e.accessRequired) window.dispatchEvent(new Event(ACCESS_REQUIRED))
      if (r.status === 409 && e.viewerGone) window.dispatchEvent(new Event(VIEWER_GONE))
      throw new Error(e.error || r.statusText)
    }
    return r.json()
  } finally {
    clearTimeout(id)
  }
}

async function _get(path) {
  return _fetch(path)
}

async function _post(path, body) {
  return _fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function _put(path, body) {
  return _fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function _delete(path) {
  return _fetch(path, { method: 'DELETE' })
}

export const getProxiedLogoUrl = (url) => {
  if (!url || !url.startsWith('http') || url.startsWith('/api/logos/render')) return url
  return `/api/logos/render?url=${encodeURIComponent(url)}`
}

// ── Access key (ACCESS_KEY) ───────────────────────────────────────────────
export const getAccessStatus = () => _get('/access/status')
export const accessLogin     = (key) => _post('/access/login', { key })
export const accessLogout    = () => _post('/access/logout', {})

// ── Auth ──────────────────────────────────────────────────────────────────
export const connect = (body) => _post('/auth/connect', body)
export async function disconnect() {
  const result = await _delete('/auth/disconnect')
  invalidateChannelCache()
  invalidateFavoritesCache()
  return result
}
export const getStatus = () => _get('/auth/status')
// Languages offered for the per-profile hide filter — union of channel genres
// and VOD categories, so portal spelling variants are each togglable.
export const getLanguages = () => _get('/channels/languages')
export const getConfig = () => _get('/auth/config')
export const saveConfig = (body) => _put('/auth/config', body)

// ── Settings ──────────────────────────────────────────────────────────────
export const getSettings = () => _get('/settings')
export const saveSettings = (body) => _post('/settings', body)

// ── Viewers ───────────────────────────────────────────────────────────────
// Each person's favorites and channel filters (backend routes/viewers.js).
// "me" is whichever viewer this device sends in X-Viewer.
export const getViewers    = () => _get('/viewers')
export const createViewer  = (body) => _post('/viewers', body)
export const updateViewer  = (id, body) => _put(`/viewers/${encodeURIComponent(id)}`, body)
export const deleteViewer  = (id) => _delete(`/viewers/${encodeURIComponent(id)}`)
export const getMyViewer   = () => _get('/viewers/me')
export const saveMyFilters = (body) => _put('/viewers/me/filters', body)

// ── Profiles ──────────────────────────────────────────────────────────────
// Server-side portal connection profiles — same list on every browser/device
// talking to this container (see lib/profiles.js).
export const getProfilesRemote      = ()          => _get('/profiles')
export const createProfileRemote    = (profile)   => _post('/profiles', profile)
export const updateProfileRemote    = (id, patch) => _put(`/profiles/${id}`, patch)
export const deleteProfileRemote    = (id)        => _delete(`/profiles/${id}`)
export const setActiveProfileRemote = (id)        => _put('/profiles/active', { id })

// ── Channels & Groups ─────────────────────────────────────────────────────
export const getChannels = (group = null, refresh = false) => {
  const params = new URLSearchParams()
  if (group) params.set('group', group)
  if (refresh) params.set('refresh', '1')
  return _get(`/channels?${params}`)
}

export const getGroups = (refresh = false) =>
  _get(`/channels/groups/all${refresh ? '?refresh=1' : ''}`)

// ── EPG ───────────────────────────────────────────────────────────────────
export const getEpg = (period = 24) => _get(`/epg?period=${period}`)
export const getChannelEpg = (channelId, period = 24) =>
  _get(`/epg/${channelId}?period=${period}`)
export const getNowNext = () => _get('/epg/now')

// ── Logos ─────────────────────────────────────────────────────────────────
export const getLogos = () => _get('/logos')
export const getLogoMap = () => _get('/logos/map')
export const addLogoOverride = (name, url) => _post('/logos', { name, url })
export const deleteLogoOverride = (name) => _delete(`/logos/${encodeURIComponent(name)}`)
export const refreshLogosDb = () => _post('/logos/refresh', {})
export const getLogoStripWords = () => _get('/logos/strip')
export const addLogoStripWord = (word) => _post('/logos/strip', { word })
export const deleteLogoStripWord = (word) => _delete(`/logos/strip/${encodeURIComponent(word)}`)

// ── Favorites ─────────────────────────────────────────────────────────────
export const getFavorites = () => _get('/favorites')
export const addFavoriteChannel = (uniqueId) => _post('/favorites/channels', { uniqueId })
export const removeFavoriteChannel = (uniqueId) => _delete(`/favorites/channels/${uniqueId}`)
export const createFavoriteGroup = (name) => _post('/favorites/groups', { name })
export const renameFavoriteGroup = (id, name) => _put(`/favorites/groups/${id}`, { name })
export const deleteFavoriteGroup = (id) => _delete(`/favorites/groups/${id}`)
export const addChannelToGroup = (groupId, uniqueId) => _post(`/favorites/groups/${groupId}/channels`, { uniqueId })
export const removeChannelFromGroup = (groupId, uniqueId) => _delete(`/favorites/groups/${groupId}/channels/${uniqueId}`)

// ── STBEmu export ─────────────────────────────────────────────────────────
// Pass a profile object to export that specific profile (connected or not);
// omit it to export the currently-connected/saved config.
export async function downloadStbEmuBackup(profile) {
  const r = await fetch('/api/export/stbemu', profile ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  } : undefined)
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }))
    throw new Error(e.error || r.statusText)
  }
  const blob = await r.blob()
  const cd   = r.headers.get('Content-Disposition') || ''
  const m    = cd.match(/filename="([^"]+)"/)
  const name = m ? m[1] : 'stbemu.backup.json'
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

// ── Channel progress ──────────────────────────────────────────────────────
export const getChannelProgress = () => _get('/channels/progress')

// ── Channel stream health ───────────────────────────────────────────────────
// { [uniqueId]: { errors, lastError } } — recent stream-resolution failures,
// self-healing (cleared on a successful play). In-memory per server process.
export const getChannelHealth = () => _get('/channels/health')

// ── Favorites order ───────────────────────────────────────────────────────
export const reorderFavoriteChannels = (order) => _put('/favorites/channels/order', { order })
export const reorderFavoriteGroups   = (order) => _put('/favorites/groups/order',   { order })

// ── Stream ────────────────────────────────────────────────────────────────
export const getStreamUrl = (channelId) => _get(`/stream/${channelId}`)
export const streamKeepalive = () => _get('/stream/keepalive')

// ── VOD progress (Continue Watching) ─────────────────────────────────────
// What the current viewer watched (backend viewers/WatchStore.js).
export const getWatch          = ()      => _get('/vod/watch')
export const saveWatch         = (entry) => _put('/vod/watch', entry)
export const removeWatchTitle  = (id)    => _delete(`/vod/watch/history/${encodeURIComponent(id)}`)
export const clearWatchHistory = ()      => _delete('/vod/watch/history')
// My List (watch later), per viewer.
export const addToWatchList        = (item)          => _put('/vod/watch/list', item)
export const removeFromWatchList   = (id)            => _delete(`/vod/watch/list/${encodeURIComponent(id)}`)
export const setWatchListCompleted = (id, completed) => _put(`/vod/watch/list/${encodeURIComponent(id)}/completed`, { completed })

// ── VOD ───────────────────────────────────────────────────────────────────
export const getVodCategories = (type = 'vod') =>
  _get(`/vod/categories?type=${type}`)
// Every category, hidden ones included — for Settings → My channels.
export const getAllVodCategories = (type = 'vod') =>
  _get(`/vod/categories?type=${type}&all=1`)

// sort: 'name' (A–Z) or 'added' (newest first) — the portal's own order.
// A category's whole listing as it is read (backend routes/vod.js): titles from
// `from` on, plus loaded / total / complete.
export const getVodListing = ({ type = 'vod', category, from = 0 }) =>
  _get(`/vod/listing?${new URLSearchParams({ type, category: String(category), from: String(from) })}`)

export const getVodItems = ({ type = 'vod', category, page = 1, search = '', fav = 0, sort = 'added' }) => {
  const p = new URLSearchParams({ type, category: String(category), page: String(page), sort })
  if (search) p.set('search', search)
  if (fav)    p.set('fav', '1')
  return _get(`/vod/items?${p}`)
}

export const getVodSeasons = (showId) =>
  _get(`/vod/seasons/${showId}`)

export const getVodEpisodes = (showId, seasonId) =>
  _get(`/vod/episodes/${showId}/${seasonId}`)

export const getVodStreamUrl = ({ videoId, cmd = '', series = 0, seasonId = '', episodeId = '' }) => {
  const p = new URLSearchParams({ videoId: String(videoId) })
  if (cmd)       p.set('cmd', cmd)
  if (series)    p.set('series', String(series))
  if (seasonId)  p.set('seasonId', String(seasonId))
  if (episodeId) p.set('episodeId', String(episodeId))
  return _get(`/vod/stream?${p}`)
}

// ── Downloads (save VOD to server disk) ──────────────────────────────────
export const getDownloads     = ()       => _get('/downloads')
export const enqueueDownloads = (items)  => _post('/downloads', { items })
export const cancelDownload   = (id)     => _delete(`/downloads/${encodeURIComponent(id)}`)

