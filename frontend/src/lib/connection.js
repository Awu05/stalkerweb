import { normalizePortal } from './profiles'

// What the app is connected to, for showing at all times (sidebar, Settings):
// { name, host } — the IPTV connection's name, and the portal's address.
// The connection is the saved profile for this portal and MAC (else any for
// this portal), else just the portal's address. Null when not connected
// (asleep counts: it names the portal the next use reconnects to).
export function connectionLabel(status, profiles = []) {
  if (!portalUsable(status) || !status.portal) return null
  let host = status.portal
  try { host = new URL(status.portal).host } catch { /* not a URL — shown as it is */ }
  const portal = normalizePortal(status.portal)
  const mac = String(status.mac ?? '').toUpperCase()
  const match = profiles.find((p) => p.portal && normalizePortal(p.portal) === portal && String(p.mac ?? '').toUpperCase() === mac)
    ?? profiles.find((p) => p.portal && normalizePortal(p.portal) === portal)
  return { name: match?.name?.trim() || host, host }
}

// Asleep: the server's idle timeout dropped the portal session, and the first
// data request reconnects it (backend lib/portalSession.js). The pages stay
// open — nothing bounces to Settings — and the first page's request wakes it.
export function portalUsable(status) {
  return !!(status?.connected || status?.asleep)
}

// The sidebar's connection badge: { text, tone } — tone 'ok' | 'asleep' | 'error' | 'off'.
export function connectionBadge(status) {
  if (status?.connected) return { text: 'Connected', tone: 'ok' }
  if (status?.asleep && status.wakeError) return { text: `Couldn't reconnect: ${status.wakeError}`, tone: 'error' }
  if (status?.asleep) return { text: 'Asleep — reconnects when you use it', tone: 'asleep' }
  return { text: 'Disconnected', tone: 'off' }
}

// Settings → IPTV connection: { portals, reconnect, disconnect } — whether it
// offers the portals to pick and Reconnect (disconnected, or a wake that
// failed), and Disconnect (connected or asleep: it stops the reconnect on use).
export function connectionActions(status) {
  const failedWake = !!(status?.asleep && status.wakeError && !status.connected)
  const usable = portalUsable(status)
  return { portals: !usable || failedWake, reconnect: !usable || failedWake, disconnect: usable }
}
