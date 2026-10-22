import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The ✕ at the end of a search box: clears it (and gives the box its focus
 * back). Shown only with something typed; the box needs room on the right (pr-7)
 * and a relative parent.
 */
export function ClearSearch({ value, onClear, className }) {
  if (!value) return null
  return (
    <button
      type="button"
      onClick={(e) => { onClear(); e.currentTarget.parentElement?.querySelector('input')?.focus() }}
      aria-label="Clear search"
      title="Clear search"
      className={cn('absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors', className)}
    >
      <X size={14} />
    </button>
  )
}
