import { normalizePortal } from './profiles'

// What the app is connected to, for showing at all times (sidebar, Settings):
// { name, host } — the IPTV connection's name, and the portal's address.
// The connection is the saved profile for this portal and MAC (else any for
// this portal), else just the portal's address. Null when not connected.
export function connectionLabel(status, profiles = []) {
  if (!status?.connected || !status.portal) return null
  let host = status.portal
  try { host = new URL(status.portal).host } catch { /* not a URL — shown as it is */ }
  const portal = normalizePortal(status.portal)
  const mac = String(status.mac ?? '').toUpperCase()
  const match = profiles.find((p) => p.portal && normalizePortal(p.portal) === portal && String(p.mac ?? '').toUpperCase() === mac)
    ?? profiles.find((p) => p.portal && normalizePortal(p.portal) === portal)
  return { name: match?.name?.trim() || host, host }
}
