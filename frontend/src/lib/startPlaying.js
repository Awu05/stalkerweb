/**
 * Starts a <video> the way both players do (pages/PlayerPage.jsx,
 * pages/VodPlayerPage.jsx) — when a title loads, and on play / Space: with
 * sound unless the viewer muted it.
 *
 *   NotAllowedError — the browser refuses sound before a click or key: it
 *     plays muted rather than not at all, and the sound comes back at once if
 *     the page has had one by now (as when the title was picked with a click).
 *     If unmuting stops it (Safari allows sound only right after a gesture),
 *     it stays muted and playing.
 *   AbortError — a newer load (the stream starting over, an episode switch,
 *     hls.js recovering) cut the play short: that load's to start. Nothing
 *     changes: null.
 *   anything else (NotSupportedError: a file that can't be played) — it
 *     didn't start: { playing: false }.
 *
 * Resolves to { playing, muted, error? } (muted: whether it ended up muted),
 * or null for a play cut short.
 */
export async function startPlaying(video, { userMuted = false, hadActivation = () => !!globalThis.navigator?.userActivation?.hasBeenActive } = {}) {
  video.muted = userMuted
  try {
    await video.play()
    return { playing: true, muted: userMuted }
  } catch (err) {
    if (err?.name === 'AbortError') return null
    if (err?.name !== 'NotAllowedError') return { playing: false, muted: userMuted, error: err?.name || 'Error' }
  }
  video.muted = true
  try {
    await video.play()
  } catch (err) {
    if (err?.name === 'AbortError') { video.muted = userMuted; return null }
    return { playing: false, muted: true, error: err?.name || 'Error' }
  }
  if (userMuted || !hadActivation()) return { playing: true, muted: true }
  video.muted = false
  // A browser that won't let it play with sound after all pauses it: muted again, playing on.
  await new Promise((r) => setTimeout(r, 0))
  if (!video.paused) return { playing: true, muted: false }
  video.muted = true
  try {
    await video.play()
    return { playing: true, muted: true }
  } catch (err) {
    return err?.name === 'AbortError' ? null : { playing: false, muted: true, error: err?.name || 'Error' }
  }
}
