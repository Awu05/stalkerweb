// What the current viewer has watched on the VOD page — resume points, the
// "Recently watched" history and the titles finished — kept on the server per
// viewer (backend viewers/WatchStore.js), so it follows them to any device.
// Held here in memory for instant reads: loadWatch() fetches it (on start-up,
// on a viewer switch, when the VOD page opens), and each save answers with the
// viewer's lists, which replace it.

import { getWatch, saveWatch, removeWatchTitle, clearWatchHistory } from '../stalkerApi'

// Mirrors backend viewers/WatchStore.js.
export const VOD_RESUME_MIN_SECS = 30     // less is "only just started"
export const VOD_DONE_FRACTION   = 0.95   // more is finished

let watch = { progress: [], history: [], watched: [] }
const listeners = new Set()

function set(next) {
  if (!next || !Array.isArray(next.progress)) return
  watch = next
  listeners.forEach((fn) => fn(watch))
}

/** Called with the viewer's lists whenever they change; returns an unsubscribe. */
export function onWatchChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function loadWatch() {
  try { set(await getWatch()) } catch { /* offline or signed out — keep what's here */ }
  return watch
}

// Composite key so a movie and each episode of a series track independently.
export function makeVodKey({ videoId, seasonId = '', episodeId = '' }) {
  return [videoId, seasonId, episodeId].filter(Boolean).join(':')
}

export function getVodProgress(key) {
  return watch.progress.find((e) => e.key === key) || null
}

/** Recently watched, newest first: a show once, with the episode played last. */
export function getVodHistory() {
  return watch.history
}

// entry: { key, title, episodeTitle, screenshotUrl, params, position, duration }.
// The server decides what to keep: nothing for a title only just started, no
// resume point once finished (but it stays in the history, marked watched).
export function saveVodProgress(entry) {
  if (!entry?.key || !entry.duration || !isFinite(entry.duration)) return
  saveWatch(entry).then(set).catch(() => {})
}

export function removeFromVodHistory(titleId) {
  set({ ...watch, history: watch.history.filter((e) => e.id !== titleId), progress: watch.progress.filter((e) => e.key.split(':')[0] !== titleId) })
  removeWatchTitle(titleId).then(set).catch(() => loadWatch())
}

export function clearVodHistory() {
  set({ ...watch, history: [] })
  clearWatchHistory().then(set).catch(() => loadWatch())
}

/** Ids of titles the viewer started or finished — for the "Not watched" filter. */
export function getWatchedVodIds() {
  const ids = new Set(watch.watched)
  for (const e of watch.history) ids.add(String(e.id))
  for (const e of watch.progress) ids.add(String(e.key).split(':')[0])
  return ids
}
