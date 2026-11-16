import { useEffect, useState } from 'react'
import { Check, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMyList, markMyListCompleted, onWatchChange } from '@/lib/vodProgress'

const completedOf = (id) => !!getMyList().find((e) => e.id === String(id))?.completedAt

// A title (a show's page) to My List's Completed, or back to To watch — put
// on My List first when it isn't there. The words go on narrow screens.
export default function CompletedButton({ item, className }) {
  const [done, setDone] = useState(() => completedOf(item.id))
  useEffect(() => {
    setDone(completedOf(item.id))
    return onWatchChange(() => setDone(completedOf(item.id)))
  }, [item.id])
  const label = done ? 'Completed — move back to To watch' : 'Mark completed'
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); markMyListCompleted(item, !done) }}
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
