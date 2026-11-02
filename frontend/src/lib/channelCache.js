import { getChannels, getGroups, getLogoMap, getChannelProgress } from '../stalkerApi'

// ── Module-level state ────────────────────────────────────────────────────────
// `cache`      — last known snapshot ({ channels, groups, logoMap, loading })
// `inflight`   — deduplicates concurrent initial fetches
// `polling`    — true while the background progress poller is running
// `generation` — incremented on invalidate so stale pollers self-cancel
// `listeners`  — components subscribed to channel-data updates

let cache = null
let inflight = null
let polling = false
let generation = 0
const listeners = new Set()

function notify(data) {
  listeners.forEach(fn => fn(data))
}

// Right after the server reconnects its lists can come back empty with
// loading: true — a list already shown is kept until the real one arrives.
// Only the lists `next` carries are looked at.
export function keepLists(prev, next) {
  const out = { ...next }
  for (const key of ['channels', 'groups']) {
    if (!(key in next)) continue
    if (next.loading && !next[key]?.length && prev?.[key]?.length) out[key] = prev[key]
  }
  return out
}

// What the poller asks: never wakes an asleep server (stalkerApi.js).
const BG = { background: true }

// Opens a Server-Sent Events connection to /api/channels/events and re-fetches
// the channel list every time the backend's page count grows — so the grid
// fills in page-by-page instead of sitting empty until the whole load
// finishes — then does one last fetch once loading=false.  Falls back to
// polling if SSE is unavailable.
function startPolling(gen) {
  if (polling) return
  polling = true
  let lastCount = -1

  // Re-fetches the channel list if the backend's count moved since our last
  // fetch (skips redundant re-fetches on ticks where nothing new landed).
  const refetch = async (loading) => {
    const chRes = await getChannels(null, false, BG)
    if (gen !== generation) return
    if (chRes?.channels) {
      cache = { ...cache, ...keepLists(cache, { channels: chRes.channels, loading }) }
      // The genres came back empty while loading: ask again once it's done.
      if (!loading && !cache.groups?.length) {
        const grpRes = await getGroups(false, BG).catch(() => null)
        if (gen !== generation) return
        if (grpRes?.groups?.length) cache = { ...cache, groups: grpRes.groups }
      }
      notify(cache)
    }
  }

  // Try SSE first (lower latency, no round-trips)
  if (typeof EventSource !== 'undefined') {
    const es = new EventSource('/api/channels/events')
    es.onmessage = async (e) => {
      if (gen !== generation) { es.close(); polling = false; return }
      try {
        const prog = JSON.parse(e.data)
        if (!prog.loading) {
          es.close()
          await refetch(false)
          polling = false
          return
        }
        if (prog.channelCount !== lastCount) {
          lastCount = prog.channelCount
          await refetch(true)
        }
      } catch { /* ignore parse errors */ }
    }
    es.onerror = () => {
      es.close()
      polling = false
      // Fall back to a single delayed retry
      setTimeout(() => _pollOnce(gen), 3000)
    }
    return
  }

  // Fallback: plain polling when EventSource is unavailable
  _pollOnce(gen)
}

async function _pollOnce(gen) {
  polling = true
  let lastCount = -1
  try {
    while (true) {
      await new Promise(r => setTimeout(r, 1500))
      if (gen !== generation) break
      const prog = await getChannelProgress(BG)
      if (gen !== generation) break
      if (!prog.loading) {
        const [chRes, grpRes] = await Promise.all([getChannels(null, false, BG), cache?.groups?.length ? null : getGroups(false, BG).catch(() => null)])
        if (gen !== generation) break
        if (chRes?.channels) {
          cache = { ...cache, channels: chRes.channels, loading: false, ...(grpRes?.groups?.length ? { groups: grpRes.groups } : {}) }
          notify(cache)
        }
        break
      }
      if (prog.channelCount !== lastCount) {
        lastCount = prog.channelCount
        const chRes = await getChannels(null, false, BG)
        if (gen !== generation) break
        if (chRes?.channels) {
          cache = { ...cache, ...keepLists(cache, { channels: chRes.channels, loading: true }) }
          notify(cache)
        }
      }
    }
  } catch { /* best-effort */ } finally {
    polling = false
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns immediately with whatever the backend has right now (may be a
// partial channel list while loading is in progress).  If the backend reports
// loading=true, starts a background poller that will call subscribeChannelUpdates
// listeners when the full data is ready.
export async function getCachedChannelData() {
  if (cache) return cache
  if (inflight) return inflight

  const gen = generation
  const promise = Promise.all([getChannels(), getGroups(), getLogoMap()])
    .then(([chRes, grpRes, logoMap]) => {
      if (inflight === promise) inflight = null
      // A portal switch invalidated the cache while this fetch was in
      // flight — discard the stale result instead of resurrecting the old
      // portal's channels, and let the (already re-triggered) fresh fetch win.
      if (gen !== generation) return getCachedChannelData()
      cache = {
        channels: chRes.channels ?? [],
        groups:   grpRes.groups ?? [],
        logoMap,
        loading:  chRes.loading ?? false,
      }
      // If backend is still loading, start polling so subscribers get the
      // complete list once it arrives — without blocking the caller.
      if (cache.loading) startPolling(gen)
      return cache
    })
    .catch(e => { if (inflight === promise) inflight = null; throw e })

  inflight = promise
  return inflight
}

// Register a callback that fires whenever the full channel data arrives from
// the background poller.  Returns an unsubscribe function.
export function subscribeChannelUpdates(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Clears the cache (e.g. on disconnect).  Increments generation so any
// in-progress poller self-cancels rather than overwriting the cleared state.
export function invalidateChannelCache() {
  cache = null
  inflight = null
  generation++
}
