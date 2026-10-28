/**
 * Starts a <video> the way both players do (pages/PlayerPage.jsx,
 * pages/VodPlayerPage.jsx): with sound unless the viewer muted it.
 *
 * Browsers refuse sound before the page has had a click or a key
 * (NotAllowedError): then it plays muted rather than not at all — and the
 * sound comes back at once if the page has had one by now, as it has when
 * the title was picked with a click. A play() that a newer load cut short
 * (AbortError: the stream starting over, an episode switch) is that load's
 * to start, and mutes nothing.
 *
 * Resolves to { playing, muted } — muted: whether it ended up muted — or
 * null when the play was cut short.
 */
export async function startPlaying(video, { userMuted = false, hadActivation = () => !!globalThis.navigator?.userActivation?.hasBeenActive } = {}) {
  video.muted = userMuted
  try {
    await video.play()
    return { playing: true, muted: userMuted }
  } catch (err) {
    if (err?.name !== 'NotAllowedError') return null
  }
  video.muted = true
  try {
    await video.play()
  } catch {
    return { playing: false, muted: true }
  }
  if (!userMuted && hadActivation()) {
    video.muted = false
    return { playing: true, muted: false }
  }
  return { playing: true, muted: true }
}
