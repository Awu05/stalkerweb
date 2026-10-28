import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { allTimezones, filterTimezones, utcOffset } from '@/lib/timezones'

/**
 * A time zone, picked from all of them: type to narrow the list (a city,
 * a region, "+05:30"), then click one or use ↑ ↓ and Enter. Escape or
 * leaving keeps the zone there was. `value` is an IANA name ("Europe/London").
 */
export default function TimezonePicker({ id, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const boxRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)

  const zones = useMemo(() => allTimezones(value), [value])
  // The offsets now, worked out once for the list (the same moment for all).
  const offsets = useMemo(() => {
    const now = new Date()
    return new Map(zones.map((z) => [z, utcOffset(z, now)]))
  }, [zones])
  const matches = useMemo(() => filterTimezones(zones, query, (z) => offsets.get(z) || ''), [zones, query, offsets])

  const openList = () => {
    if (open) return
    setQuery('')
    setOpen(true)
    // Start at the zone there is, so ↑ ↓ go from it.
    setActive(Math.max(0, zones.indexOf(value)))
  }
  const close = () => { setOpen(false); setQuery('') }
  const pick = (zone) => { onChange(zone); close(); inputRef.current?.focus() }

  // The highlighted zone kept in view.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // A press outside closes it.
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!boxRef.current?.contains(e.target)) close() }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  function onKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { openList(); return }
      setActive((i) => Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), Math.max(matches.length - 1, 0)))
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()   // not the form's submit
      if (matches[active]) pick(matches[active])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()   // the list, not the dialog it's in
      close()
    } else if (e.key === 'Tab') {
      close()
    }
  }

  const listId = `${id}-list`
  const shown = open ? query : value ? `${value}${offsets.get(value) ? `  (${offsets.get(value)})` : ''}` : ''

  return (
    <div ref={boxRef} className="relative">
      <input
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
        onFocus={openList}
        onClick={openList}
        onChange={(e) => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true) }}
        onKeyDown={onKeyDown}
        className="flex h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] pl-3 pr-8 py-1 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary-light)]"
      />
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="modal-panel absolute z-50 mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-[var(--radius-md)] py-1 text-sm"
        >
          {matches.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No time zone matches “{query}”.</li>}
          {matches.map((z, i) => (
            <li
              key={z}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={z === value}
              onPointerDown={(e) => e.preventDefault()}   // keep the focus in the box
              onClick={() => pick(z)}
              onPointerMove={() => setActive(i)}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5', i === active && 'bg-[var(--color-surface-3)]')}
            >
              <span className="w-3.5 shrink-0">{z === value && <Check size={13} className="text-[var(--color-primary-light)]" />}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{z.replace(/_/g, ' ')}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">{offsets.get(z)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
