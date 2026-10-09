import { useEffect, useState } from 'react'
import { Bookmark } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isInMyList, onWatchChange, toggleMyList } from '@/lib/vodProgress'

// Puts a VOD title on the viewer's My List, or takes it off. `overlay`: the
// small round icon on a tile (inside the tile's own button, so a span acting
// as one); otherwise a labelled button.
export default function MyListButton({ item, overlay = false, className }) {
  const [saved, setSaved] = useState(() => isInMyList(item.id))
  useEffect(() => {
    setSaved(isInMyList(item.id))
    return onWatchChange(() => setSaved(isInMyList(item.id)))
  }, [item.id])

  const label = saved ? 'Remove from My List' : 'Add to My List'
  const toggle = (e) => { e.stopPropagation(); e.preventDefault(); toggleMyList(item) }

  if (overlay) {
    return (
      <span
        role="button"
        tabIndex={0}
        title={label}
        aria-label={label}
        aria-pressed={saved}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e) }}
        className={cn(
          'p-2 rounded-full bg-black/60 hover:bg-black/80 transition-all',
          saved ? 'text-[var(--color-primary-light)] opacity-100' : 'text-white/80 hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          className,
        )}
      >
        <Bookmark size={18} fill={saved ? 'currentColor' : 'none'} />
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={saved}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors',
        saved ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]',
        className,
      )}
    >
      <Bookmark size={13} fill={saved ? 'currentColor' : 'none'} />
      {saved ? 'On My List' : 'My List'}
    </button>
  )
}
