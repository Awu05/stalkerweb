import { useEffect, useRef } from 'react'

// Inputs that aren't typed into: Space presses or ticks them.
const NOT_TYPED = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'])

/** Whether a key on `target` is typing — a text box, a select, editable text — not a shortcut. */
export function isTypingTarget(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  return target.tagName === 'INPUT' && !NOT_TYPED.has(String(target.type || 'text').toLowerCase())
}

// Whether the focus shows (reached by the keyboard, not left by a click).
function focusShows(el) {
  try { return el.matches(':focus-visible') } catch { return false }
}

// Where Space is the player's: nothing focused (the page itself), the video,
// or a control of the player's bar (`data-player-controls`) the mouse just
// clicked — it keeps the focus and would press itself on the same Space,
// undoing the toggle. A control reached by the keyboard keeps its Space
// (Tab to the subtitles button, Space opens it), and so does everything
// else: a menu's item, a dialog's switch, the Up next card's Play now, a
// text box.
function isPlayersSpace(target) {
  if (!target || target === document.body || target === document.documentElement) return true
  if (isTypingTarget(target)) return false
  if (target.tagName === 'VIDEO') return true
  return !!target.closest?.('[data-player-controls]') && !focusShows(target)
}

/**
 * Space plays or pauses the players (live TV and movies) — on the video or
 * its controls, not in a menu, dialog or text box over it. Listened for after
 * the page's own handlers (a dialog that keeps its keys still does); held
 * down, it toggles once.
 */
export function useSpaceToPlay(toggle) {
  const toggleRef = useRef(toggle)
  useEffect(() => { toggleRef.current = toggle })
  useEffect(() => {
    const ours = (e) => e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented && isPlayersSpace(e.target)
    const onDown = (e) => {
      if (!ours(e)) return
      e.preventDefault()   // no scrolling, and no press of the focused control
      if (!e.repeat) toggleRef.current()
    }
    // A button presses itself on Space's release: that one was the player's.
    const onUp = (e) => { if (ours(e)) e.preventDefault() }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])
}
