import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import EpgGridView from './EpgGridPage'
import GuideListView from './GuideListView'

// The programme guide: a grid of every channel against a timeline (the
// default), or a list of one channel's programmes. The view is in the URL
// (?view=list) and switching replaces the history entry, so Back still leaves
// the page. The station search filters either view.
const VIEWS = [
  { id: 'grid', label: 'Grid', icon: LayoutGrid },
  { id: 'list', label: 'List', icon: List },
]

export default function GuidePage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'list' ? 'list' : 'grid'
  const [query, setQuery] = useState('')

  const setView = (id) => {
    const next = new URLSearchParams(params)
    if (id === 'grid') next.delete('view')
    else next.set('view', id)
    setParams(next, { replace: true })
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] lg:h-dvh">
      <div className="flex items-center gap-3 px-3 sm:px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <h1 className="hidden sm:block text-sm font-semibold text-[var(--color-text)]">Guide</h1>

        {/* Grid | List */}
        <div role="tablist" aria-label="Guide view" className="flex rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] p-0.5">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-[calc(var(--radius-sm)-2px)] text-xs font-medium transition-colors',
                view === id
                  ? 'bg-[var(--color-primary)] text-[var(--color-bg)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* Station search */}
        <div className="relative flex-1 max-w-xs ml-auto">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setQuery('') }}
            placeholder="Search stations…"
            aria-label="Search stations by name or number"
            className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] pl-7 pr-7 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary-light)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {view === 'grid' ? <EpgGridView query={query} /> : <GuideListView query={query} />}
      </div>
    </div>
  )
}
