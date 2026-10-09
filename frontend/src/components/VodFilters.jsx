import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NO_FILTERS, filtersActive } from '@/lib/vodFilters'

// The VOD page's filter bar: genre, year, rating, recently added, HD and not
// watched yet. A filter with nothing to pick (no genres or ratings from this
// portal) isn't shown. Native selects, so a TV remote can use them too.
const selectCls = 'rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)] disabled:opacity-40'
const toggleCls = (on) => cn(
  'px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium border transition-colors disabled:opacity-40',
  on ? 'bg-[var(--color-primary)] text-[var(--color-bg)] border-transparent' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] border-[var(--color-border)] hover:text-[var(--color-text)]'
)

export default function VodFilters({ filters, onChange, options, disabled, note }) {
  const set = (patch) => onChange({ ...filters, ...patch })
  // Booleans: a bare 0 here would be drawn on the page.
  const showGenre = options.genres.length > 0 || !!filters.genre
  const showRating = options.hasRating || filters.minRating > 0

  return (
    <div className="px-4 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-2">
      {showGenre && (
        <select aria-label="Genre" className={selectCls} disabled={disabled} value={filters.genre} onChange={(e) => set({ genre: e.target.value })}>
          <option value="">Any genre</option>
          {[...new Set([...(filters.genre ? [filters.genre] : []), ...options.genres])].map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      )}
      <select aria-label="Year" className={selectCls} disabled={disabled} value={filters.year} onChange={(e) => set({ year: e.target.value })}>
        <option value="">Any year</option>
        {[...new Set([...(filters.year ? [filters.year] : []), ...options.years])].map((d) => (
          <option key={d} value={d}>{d === 'Older' ? 'Before 1980' : d}</option>
        ))}
      </select>
      {showRating && (
        <select aria-label="Rating" className={selectCls} disabled={disabled} value={String(filters.minRating)} onChange={(e) => set({ minRating: Number(e.target.value) })}>
          <option value="0">Any rating</option>
          {[6, 7, 8].map((r) => <option key={r} value={String(r)}>IMDb {r}+</option>)}
        </select>
      )}
      <select aria-label="Added" className={selectCls} disabled={disabled} value={String(filters.addedDays)} onChange={(e) => set({ addedDays: Number(e.target.value) })}>
        <option value="0">Any time</option>
        <option value="7">Added this week</option>
        <option value="30">Added this month</option>
        <option value="90">Added in 3 months</option>
      </select>
      <button type="button" aria-pressed={filters.hd} className={toggleCls(filters.hd)} disabled={disabled} onClick={() => set({ hd: !filters.hd })}>HD</button>
      <button type="button" aria-pressed={filters.unwatched} className={toggleCls(filters.unwatched)} disabled={disabled} onClick={() => set({ unwatched: !filters.unwatched })}>Not watched</button>
      {filtersActive(filters) && (
        <button type="button" onClick={() => onChange(NO_FILTERS)} className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]">
          <X size={12} /> Clear
        </button>
      )}
      {note && <span className="text-xs text-[var(--color-muted)]">{note}</span>}
    </div>
  )
}
