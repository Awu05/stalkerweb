import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Bell, BellRing, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const PANEL_WIDTH = 288 // w-72
const GAP = 8

// Where to put the panel: beside the bell, opening upward from it. The bell
// lives at the bottom of the sidebar, so a dropdown below it lands off-screen,
// and right-aligning it to the bell pushed it off the left edge. Clamped to the
// viewport so it also fits beside the overlay sidebar on a phone.
function panelPosition(button) {
  const r = button.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(GAP, Math.min(r.right + GAP, vw - PANEL_WIDTH - GAP))
  const bottom = Math.max(GAP, vh - r.bottom)
  return { left, bottom, maxHeight: vh - bottom - GAP }
}

function formatReminderTime(startTime) {
  const d = new Date(startTime * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * A bell icon button that shows a badge count when reminders are set.
 * On click, shows a dropdown list of active reminders with remove buttons.
 *
 * @param {{ reminders: import('@/lib/epgReminders').Reminder[], onRemove: (id: string) => void }} props
 */
export function ReminderBell({ reminders = [], onRemove }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const buttonRef = useRef(null)
  const panelRef = useRef(null)
  const count = reminders.length
  const hasActive = count > 0

  // Close when clicking outside. The panel is portalled out of `ref`, so it
  // has to be checked separately or clicks inside it would close it.
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (ref.current?.contains(e.target) || panelRef.current?.contains(e.target)) return
      setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Track the bell while open (window resize, sidebar collapse/expand).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const update = () => setPos(panelPosition(buttonRef.current))
    update()
    window.addEventListener('resize', update)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(document.body)
    return () => { window.removeEventListener('resize', update); ro?.disconnect() }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(v => !v)}
        className={cn(
          'relative flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] transition-colors',
          open
            ? 'bg-[var(--color-surface-2)] text-[var(--color-primary-light)]'
            : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
        )}
        aria-label={`Reminders${count > 0 ? ` (${count})` : ''}`}
        title="EPG Reminders"
      >
        {hasActive
          ? <BellRing size={16} className="text-[var(--color-primary-light)]" />
          : <Bell size={16} />
        }
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center h-4 min-w-4 px-0.5 rounded-full bg-[var(--color-primary)] text-white text-[9px] font-bold leading-none">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && pos && createPortal(
        // Portalled to <body>: the sidebar is a fixed, transformed container,
        // which clipped the panel and trapped its positioning.
        <div
          ref={panelRef}
          style={{ left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight, width: PANEL_WIDTH }}
          className="modal-panel fixed z-[60] flex flex-col rounded-[var(--radius-md)] overflow-hidden"
        >
          <div className="shrink-0 px-3 py-2 border-b border-[var(--color-border)] flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wider">
              Reminders
            </span>
            {count > 0 && (
              <span className="text-xs text-[var(--color-muted)]">{count} set</span>
            )}
          </div>

          {count === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-[var(--color-muted)]">
              No reminders set.<br />
              <span className="text-xs opacity-70">Click a future programme to set one.</span>
            </div>
          ) : (
            <ul className="max-h-64 min-h-0 overflow-y-auto divide-y divide-[var(--color-border)]">
              {reminders.map(r => (
                <li key={r.id} className="flex items-start gap-2 px-3 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)] truncate">{r.title}</p>
                    <p className="text-xs text-[var(--color-muted)] mt-0.5 truncate">
                      {r.channelName} · {formatReminderTime(r.startTime)}
                    </p>
                    {r.notifiedAt && (
                      <p className="text-[10px] text-[var(--color-primary-light)] mt-0.5">Notified</p>
                    )}
                  </div>
                  <button
                    onClick={() => onRemove(r.id)}
                    className="shrink-0 p-0.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition-colors mt-0.5"
                    aria-label="Remove reminder"
                    title="Remove"
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
