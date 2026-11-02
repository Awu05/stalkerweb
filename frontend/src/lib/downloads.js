// lib/downloads.js — shared "VOD downloads" state, backed by an SSE
// subscription to /api/downloads/events so every component watching the
// queue (the Downloads page, a "downloading…" badge elsewhere, etc.) sees
// the same list without each polling independently.

import { getDownloads, enqueueDownloads, cancelDownload } from '../stalkerApi'

let jobs = []
let es = null
const listeners = new Set()

function notify() {
  listeners.forEach(fn => fn(jobs))
}

// After the stream fails: again in 2 s, 4 s, 8 s … at most a minute.
export function streamRetryMs(attempt) {
  return Math.min(60_000, 2000 * 2 ** attempt)
}

let retryTimer = null
let attempt = 0

// Opening the Downloads page is real use: its first load is a plain GET, which
// wakes an asleep server (backend middleware/session.js); then the live
// stream, which never wakes it. When the stream fails (the server asleep,
// restarting), it is tried again, backing off, while anyone is watching.
function ensureConnected() {
  if (es || retryTimer || typeof EventSource === 'undefined') return
  fetchDownloads().catch(() => {}).finally(() => { if (listeners.size) openStream() })
}

function openStream() {
  if (es || typeof EventSource === 'undefined') return
  es = new EventSource('/api/downloads/events')
  es.onmessage = (e) => {
    attempt = 0
    try {
      jobs = JSON.parse(e.data)
      notify()
    } catch { /* ignore malformed frame */ }
  }
  es.onerror = () => {
    es?.close()
    es = null
    if (!listeners.size) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (listeners.size) openStream()   // the stream only: a retry is a timer, it never wakes the server
    }, streamRetryMs(attempt++))
  }
}

// Subscribe to the live job list. Connects the SSE stream on first
// subscriber and tears it down when the last one unsubscribes.
export function subscribeDownloads(fn) {
  listeners.add(fn)
  ensureConnected()
  fn(jobs)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) {
      if (es) { es.close(); es = null }
      clearTimeout(retryTimer)
      retryTimer = null
      attempt = 0
    }
  }
}

export function getDownloadJobs() {
  return jobs
}

// One-time fetch for a component that wants the current snapshot without
// waiting for the next SSE frame (the subscription above also delivers one
// immediately on connect, so this is mostly a convenience for callers that
// don't want to subscribe).
export async function fetchDownloads() {
  const r = await getDownloads()
  jobs = r.downloads || []
  notify()
  return jobs
}

// items: [{ videoId, cmd, series, seasonId, episodeId, title, seriesTitle }]
export async function queueDownload(items) {
  return enqueueDownloads(items)
}

export async function removeDownload(id) {
  return cancelDownload(id)
}
