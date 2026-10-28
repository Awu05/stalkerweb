import { useEffect } from 'react'

/**
 * A player the browser started muted — no sound before a click or a key, as
 * after a refresh (lib/startPlaying.js) — gets its sound back on the page's
 * first click or key, wherever it is: the gesture the browser waits for.
 *
 * Only a real gesture: unmuted on one the browser doesn't count (Escape, a
 * modifier on its own…), the video would stop. Where the browser can say
 * (navigator.userActivation), it decides; elsewhere those keys are left out.
 *
 * That first gesture is only for the sound when it lands on the playing
 * picture (a click, Space or Enter on it): it isn't also a pause, and
 * `onPicture()` stands in for what the player does with it besides (its
 * controls brought up). On a paused one it plays too; on a control, or typed
 * in a box, it does what it does there too — but the mute button's own click
 * or key (and the mute key) is left to it, or it would mute straight back.
 *
 * `onSound()` is called once; returns a function that stops listening.
 */
export function listenForSound({
  onSound, isPicture = () => false, isMuteButton = () => false, isMuteKey = () => false, onPicture = () => {},
  doc = globalThis.document, activation = () => globalThis.navigator?.userActivation,
}) {
  let done = false
  const stop = () => {
    done = true
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('keydown', onKey, true)
  }
  const sound = () => { if (done) return; stop(); onSound() }
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); onPicture() }
  function onClick(e) {
    if (isMuteButton(e.target)) { stop(); return }   // the button unmutes by itself
    if (!isGesture(e, activation())) return
    sound()
    if (isPicture(e.target)) swallow(e)
  }
  function onKey(e) {
    if (!isGesture(e, activation())) return
    const press = e.code === 'Space' || e.key === 'Enter'
    if (isMuteKey(e) || (press && isMuteButton(e.target))) { stop(); return }
    sound()
    if (press && isPicture(e.target)) swallow(e)
  }
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKey, true)
  return stop
}

// Keys no browser counts as a gesture: for one that can't say so itself.
const NOT_A_GESTURE = new Set(['Escape', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock'])

function isGesture(e, userActivation) {
  if (userActivation) return userActivation.isActive
  return e.type === 'click' || !(e.ctrlKey || e.metaKey || e.altKey || NOT_A_GESTURE.has(e.key))
}

/**
 * While `blocked` (the browser muted the player, not the viewer): the first
 * click or key brings the sound back — on the video at once, as the browser
 * needs it inside the gesture — and `setMuted(false)`. The player marks its
 * mute button `data-mute-button`; `isMuteKey` names its mute shortcut.
 */
export function useSoundOnFirstGesture(blocked, videoRef, setMuted, { isMuteKey, onPicture } = {}) {
  useEffect(() => {
    if (!blocked) return undefined
    return listenForSound({
      onSound: () => { const v = videoRef.current; if (v) v.muted = false; setMuted(false) },
      // The playing picture: the video or what holds it (the area a click pauses, the page Space pauses) — not a control on it.
      isPicture: (t) => { const v = videoRef.current; return !!v && !v.paused && !!t?.contains?.(v) },
      isMuteButton: (t) => !!t?.closest?.('[data-mute-button]'),
      isMuteKey,
      onPicture,
    })
  }, [blocked, videoRef, setMuted, isMuteKey, onPicture])
}
