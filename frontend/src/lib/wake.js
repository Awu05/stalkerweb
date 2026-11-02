// The server drops its portal session after a while with nothing playing
// (the idle timeout, 30 min by default). Opening the site, signing in, or
// coming back to the tab after a while asks it to reconnect to the last
// portal (GET /api/auth/status?wake=1); the 30-second status poll never does,
// or the session would never go idle.

/** Away from the tab this long: coming back asks the server to reconnect. */
export const WAKE_AFTER_HIDDEN_MS = 5 * 60_000

/** Whether coming back to the tab, hidden since `hiddenAt` (ms, or null), should wake the server. */
export function wakesOnReturn(hiddenAt, now = Date.now()) {
  return hiddenAt != null && now - hiddenAt >= WAKE_AFTER_HIDDEN_MS
}
