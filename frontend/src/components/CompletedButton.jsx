import { useEffect, useState } from 'react'
import { Check, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMyList, markMyListCompleted, onWatchChange } from '@/lib/vodProgress'

const entryOf = (id) => getMyList().find((e) => e.id === String(id))

// A title to My List's Completed, or back to To watch. `overlay`: the small
// round icon on a tile, beside the bookmark — only for a title on My List
// (inside the tile's own button, so a span acting as one). Otherwise a
// labelled button (a show's page), which puts a title not on My List there
// first; its words go on narrow screens.
export default function CompletedButton({ item, overlay = false, className }) {
  const [entry, setEntry] = useState(() => entryOf(item.id))
  useEffect(() => {
    setEntry(entryOf(item.id))
    return onWatchChange(() => setEntry(entryOf(item.id)))
  }, [item.id])
  const done = !!entry?.completedAt
  const label = done ? 'Completed — move back to To watch' : 'Mark completed'
  const toggle = (e) => { e.stopPropagation(); e.preventDefault(); markMyListCompleted(item, !done) }

  if (overlay) {
    if (!entry) return null
    return (
      <span
        role="button"
        tabIndex={0}
        title={label}
        aria-label={label}
        aria-pressed={done}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e) }}
        className={cn(
          'p-2 rounded-full bg-black/60 hover:bg-black/80 transition-all',
          done ? 'text-[var(--color-success)]' : 'text-white/80 hover:text-white',
          className,
        )}
      >
        {done ? <CheckCircle2 size={18} /> : <Check size={18} />}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={done}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors',
        done ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]',
        className,
      )}
    >
      {done ? <CheckCircle2 size={13} /> : <Check size={13} />}
      <span className="hidden sm:inline">{done ? 'Completed' : 'Mark completed'}</span>
    </button>
  )
}
