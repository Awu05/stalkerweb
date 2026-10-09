import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

// Settings as a window over whatever page is open (App.jsx routes /settings
// here), so a playing channel keeps playing behind it. Closes with ✕, Esc, a
// click outside, or the browser / TV-remote Back key — unless `onClose` is
// null (no portal connected yet: there is nothing to go back to).
const BACK_KEYS = new Set(['Escape', 'GoBack', 'XF86Back', 'BrowserBack'])
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function SettingsModal({ onClose, children }) {
  const root = useRef(null)
  const panel = useRef(null)

  // Focus moves in (and back out on close); the page behind stops scrolling.
  useEffect(() => {
    const before = document.activeElement
    panel.current?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
      before?.focus?.()
    }
  }, [])

  function onKeyDown(e) {
    // Keys stay in Settings: the page behind (the player's shortcuts, the
    // channel list's arrows) never sees them.
    e.stopPropagation()
    // A panel open inside Settings (profile editor, STB import) handles its own keys.
    const inner = e.target.closest?.('.fixed')
    if (inner && inner !== root.current) return
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
    const back = BACK_KEYS.has(e.key) || e.keyCode === 461 || e.keyCode === 10009 || (e.key === 'Backspace' && !typing)
    if (back) {
      if (onClose) { e.preventDefault(); onClose() }
      return
    }
    if (e.key === 'Tab') keepFocusInside(e)
  }

  function keepFocusInside(e) {
    const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus()
    }
  }

  return (
    <div ref={root} className="fixed inset-0 z-[55] flex items-stretch sm:items-center justify-center sm:p-6" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose ?? undefined} aria-hidden="true" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        // min-w-0: as a flex item it would otherwise widen to its longest link.
        // Inline outline: the panel takes focus on open, and the global focus
        // ring (index.css, unlayered) would beat an outline-none utility.
        className="relative w-full min-w-0 sm:max-w-3xl h-full sm:h-[min(90dvh,1000px)] overflow-y-auto overflow-x-hidden overscroll-contain bg-[var(--color-bg)] sm:rounded-[var(--radius-lg)] sm:border border-[var(--color-border)] shadow-2xl"
        style={{ outline: 'none' }}
      >
        {onClose && (
          <div className="sticky top-0 z-10 h-0 flex justify-end">
            <button
              onClick={onClose}
              aria-label="Close settings"
              title="Close (Esc)"
              className="mt-3 mr-3 flex items-center justify-center h-8 w-8 rounded-full bg-[var(--color-surface-2)]/90 text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
