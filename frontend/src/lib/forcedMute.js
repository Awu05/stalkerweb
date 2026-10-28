import { useEffect } from 'react'

/**
 * A player the browser started muted — no sound before a click or a key, as
 * after a refresh (lib/startPlaying.js) — gets its sound back on the page's
 * first click or key, wherever it is: the gesture the browser waits for.
 *
 * That first gesture is only for the sound when it lands on the picture
 * (a click, Space or Enter on it): it isn't also a pause. On a control, or typed in a box, it
 * does what the control does too — but the mute button's own click (and the
 * mute key) is left to it, or it would mute straight back.
 *
 * `onSound()` is called once; returns a function that stops listening.
 */
export function listenForSound({ onSound, isPicture = () => false, isMuteButton = () => false, isMuteKey = () => false, doc = globalThis.document }) {
  let done = false
  const stop = () => {
    done = true
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('keydown', onKey, true)
  }
  const sound = () => { if (done) return; stop(); onSound() }
  function onClick(e) {
    if (isMuteButton(e.target)) { stop(); return }   // the button unmutes by itself
    sound()
    if (isPicture(e.target)) { e.stopPropagation(); e.preventDefault() }
  }
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isMuteKey(e)) { stop(); return }
    sound()
    if ((e.code === 'Space' || e.key === 'Enter') && isPicture(e.target)) { e.stopPropagation(); e.preventDefault() }
  }
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKey, true)
  return stop
}

/** The mute button a player marks so its first click is its own (listenForSound). */
export const MUTE_BUTTON_ATTR = 'data-mute-button'

/**
 * While `blocked` (the browser muted the player, not the viewer): the first
 * click or key brings the sound back — on the video at once, as the browser
 * needs it inside the gesture — and `setMuted(false)`.
 */
export function useSoundOnFirstGesture(blocked, videoRef, setMuted, { isMuteKey } = {}) {
  useEffect(() => {
    if (!blocked) return undefined
    return listenForSound({
      onSound: () => { const v = videoRef.current; if (v) v.muted = false; setMuted(false) },
      // The picture: the video or what holds it (the area a click pauses, the page Space pauses) — not a control on it.
      isPicture: (t) => !!t?.contains?.(videoRef.current),
      isMuteButton: (t) => !!t?.closest?.(`[${MUTE_BUTTON_ATTR}]`),
      isMuteKey,
    })
  }, [blocked, videoRef, setMuted, isMuteKey])
}
