// The viewer this device is watching as (Settings → Viewers). Saved per
// device; the server falls back to its default viewer for an id it doesn't
// know, so a stale value never breaks a request.
const KEY = 'sw:viewer'

export function getViewerId() {
  try { return localStorage.getItem(KEY) || null } catch { return null }
}

export function setViewerId(id) {
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch { /* storage blocked — the server's default viewer is used */ }
}

// Which viewer to use on startup: the saved one while it still exists,
// otherwise ask ("Who's watching?") — even when there's only one, so a new
// device (or a fresh sign-in) can pick it or make another.
export function chooseViewer(viewers, savedId) {
  if (savedId && viewers.some(v => v.id === savedId)) return { id: savedId, needsPicker: false }
  return { id: null, needsPicker: true }
}

// Links for players outside the browser, each naming its viewer — the default
// one too. Links without a viewer (from before viewers) still work: the server
// gives them the default viewer.
export const viewerQuery = (viewer) => (viewer ? `?viewer=${encodeURIComponent(viewer.id)}` : '')
export const viewerPath  = (viewer) => (viewer ? `/v/${encodeURIComponent(viewer.id)}` : '')
