import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { filterZones, isZone, offsetLabel, offsetMinutes, zoneEntries } from '@/lib/timezones'

// A TV browser's Back (Backspace is typing here, so it isn't one).
const isBackKey = (e) => e.key === 'GoBack' || e.key === 'XF86Back' || e.keyCode === 461 || e.keyCode === 10009

/**
 * A time zone, picked from all of them (lib/timezones.js — the same list the
 * apps offer): type to narrow it (a city, a country, an offset like "UTC+1"),
 * then click one or use ↑ ↓ and Enter. Opens on a click, on typing, on Enter
 * or Alt+↓ — not on focus, so the arrows still move between fields. Escape,
 * Back or leaving keeps the zone there was. A real zone typed in full that
 * isn't listed can be used too. `value` is an IANA name ("Europe/London").
 */
export default function TimezonePicker({ id, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState(null)   // where the list goes on screen: { left, top, width, maxHeight, above }
  const boxRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)

  // The zones only once the list opens; while closed, just this one's offset.
  const entries = useMemo(() => (open ? zoneEntries(value) : []), [open, value])
  const typed = query.trim()
  const matches = useMemo(() => {
    const found = filterZones(entries, query)
    // A real zone typed in full that the list hasn't: offered first, to use as it is.
    const custom = typed && isZone(typed) && !entries.some((z) => z.id.toLowerCase() === typed.toLowerCase())
    return custom ? [{ id: typed, label: offsetLabel(offsetMinutes(typed)), custom: true }, ...found] : found
  }, [entries, query, typed])
  const valueOffset = useMemo(() => offsetLabel(offsetMinutes(value)), [value])

  const openList = (q = '') => {
    setQuery(q)
    setActive(0)
    setOpen(true)
  }
  const close = () => { setOpen(false); setQuery('') }
  const pick = (zone) => { onChange(zone); close(); inputRef.current?.focus() }

  // Opened at the zone there is, so ↑ ↓ go from it.
  useEffect(() => {
    if (open && !query) setActive(Math.max(0, matches.findIndex((z) => z.id === value)))
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The list floats over the page, under the box (or over it, near the bottom
  // of the screen) — inside the form it would be cut off by its scrolling.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const r = inputRef.current?.getBoundingClientRect()
      if (!r) return
      const below = window.innerHeight - r.bottom - 8
      const above = r.top - 8
      const up = below < 200 && above > below
      setPlace({ left: r.left, width: r.width, top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined, maxHeight: Math.min(256, Math.max(120, up ? above : below)) })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [open])

  // The highlighted zone kept in view — the list scrolled, not the page.
  useEffect(() => {
    const list = listRef.current
    const row = list?.querySelector(`[data-index="${active}"]`)
    if (!list || !row) return
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
  }, [active, open, place])

  // A press outside closes it.
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!boxRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) close() }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  function onKeyDown(e) {
    if (!open) {
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); openList() }
      return   // the arrows move between the form's fields, as in any other box
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), Math.max(matches.length - 1, 0)))
    } else if (e.key === 'Enter') {
      e.preventDefault()   // not the form's submit
      if (matches[active]) pick(matches[active].id)
    } else if (e.key === 'Escape' || isBackKey(e)) {
      e.preventDefault()
      e.stopPropagation()   // the list, not the sheet it's in
      close()
    } else if (e.key === 'Tab') {
      close()
    }
  }

  // Typing with the list closed starts a search with what was typed, not after the zone shown.
  function onType(e) {
    const text = e.target.value
    if (open) { setQuery(text); setActive(0); return }
    openList(text.startsWith(shown) ? text.slice(shown.length) : text)
  }

  const listId = `${id}-list`
  const shown = open ? query : value ? `${value}${valueOffset ? `  (${valueOffset})` : ''}` : ''

  return (
    <div ref={boxRef} className="relative">
      <Input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={shown}
        placeholder={open ? (value || 'Search time zones…') : 'Choose a time zone'}
        onClick={() => { if (!open) openList() }}
        onChange={onType}
        onKeyDown={onKeyDown}
        // The focus leaving the box (Tab, a phone's Next): the list goes with it.
        onBlur={(e) => { if (!listRef.current?.contains(e.relatedTarget)) close() }}
        className="pr-8"
      />
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
      {open && place && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          style={{ left: place.left, top: place.top, bottom: place.bottom, width: Math.max(place.width, 256), maxHeight: place.maxHeight }}
          className="modal-panel fixed z-[1000] overflow-y-auto rounded-[var(--radius-md)] py-1 text-sm"
        >
          {matches.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No time zone matches “{query}”.</li>}
          {matches.map((z, i) => (
            <li
              key={z.custom ? `custom:${z.id}` : z.id}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={z.id === value}
              onPointerDown={(e) => e.preventDefault()}   // keep the focus in the box
              onClick={() => pick(z.id)}
              onPointerMove={() => setActive(i)}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5', i === active && 'bg-[var(--color-surface-3)]')}
            >
              <span className="w-3.5 shrink-0">{z.id === value && <Check size={13} className="text-[var(--color-primary-light)]" />}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
                {z.custom ? <>Use “{z.id}”</> : z.id.replace(/_/g, ' ')}
                {z.country && <span className="ml-1.5 text-xs text-[var(--color-muted)]">{z.country}</span>}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">{z.label}</span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  )
}
