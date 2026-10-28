import { useEffect, useRef } from 'react'

// Not while typing: there a space is a space.
const typing = (t) => /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '') || !!t?.isContentEditable

/**
 * Space plays or pauses the players (live TV and movies) — wherever the
 * focus is, except a text box. It's taken before anything else on the page:
 * a focused button (play/pause, just clicked) would otherwise press itself on
 * the same Space, undoing the toggle, and the page would scroll. Held down,
 * it toggles once.
 */
export function useSpaceToPlay(toggle) {
  const toggleRef = useRef(toggle)
  useEffect(() => { toggleRef.current = toggle })
  useEffect(() => {
    const ours = (e) => e.code === 'Space' && !typing(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey
    const onDown = (e) => {
      if (!ours(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) toggleRef.current()
    }
    // A button presses itself on Space's release: that one isn't its.
    const onUp = (e) => {
      if (!ours(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [])
}
