import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/appContext'
import { Switch } from '@/components/ui/switch'
import { getGroups, getAllVodCategories, getMyViewer, saveMyFilters } from '../stalkerApi'
import { invalidateChannelCache } from '../lib/channelCache'
import { serialSaves } from '@/lib/serialSaves'
import { showToast } from '@/lib/toast'
import { convertLanguages, groupGenres, titleKey, vodCategoryList } from '@/lib/channelFilters'

// Settings → My channels: what the current viewer sees. Show Adult, the Live TV
// categories (grouped by the part before the "|") and the Movies & Series
// categories, each hideable, with one search across both. Changes show at once
// and are saved in the order made; a failed save puts back what the server has.

const chip = (hidden) => cn(
  'px-3 py-1.5 rounded-full text-xs font-semibold transition-all border text-left',
  hidden
    ? 'bg-[var(--color-surface-2)] text-[var(--color-muted)] border-[var(--color-border)] opacity-50 line-through'
    : 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)] border-[var(--color-primary)]/30 hover:bg-[var(--color-primary)]/25'
)
const linkBtn = 'text-[10px] font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors shrink-0'

const toHiddenMap = (list) => new Map((list ?? []).map((t) => [titleKey(t), t]))

function AllNone({ onAll, onNone }) {
  return (
    <>
      <button type="button" onClick={onAll} className={linkBtn}>All</button>
      <span className="text-[10px] text-[var(--color-border)]">/</span>
      <button type="button" onClick={onNone} className={linkBtn}>None</button>
    </>
  )
}

export default function ChannelFilters() {
  const { connected, showAdult, setShowAdult, disabledGenres, setDisabledGenres, setDisabledLanguages, applyViewer } = useApp()
  const [genres, setGenres]       = useState(null)   // live categories, null while loading
  const [vodTitles, setVodTitles] = useState(null)   // movie & series category names
  // Hidden movie & series categories, titleKey() → name. Names no longer on the
  // portal stay saved, in case they come back.
  const [hiddenVod, setHiddenVod] = useState(() => new Map())
  const [query, setQuery]         = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())

  const saveFilters = useMemo(() => serialSaves(saveMyFilters), [])
  function saveFailed() {
    showToast('Could not save your channel filters', 'error')
    getMyViewer().then((me) => { applyViewer(me); setHiddenVod(toHiddenMap(me.disabledVodCategories)) }).catch(() => {})
  }

  // The lists, and this viewer's hidden movie & series categories. A viewer
  // who hid "languages" before has them turned into the matching categories.
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    const live = getGroups().then((r) => (r.groups ?? []).filter((g) => g.name && g.name.toLowerCase() !== 'all'))
    const vod = Promise.all([getAllVodCategories('vod'), getAllVodCategories('series').catch(() => ({ categories: [] }))])
      .then(([m, s]) => vodCategoryList(m.categories, s.categories))
    Promise.all([live.catch(() => null), vod.catch(() => null), getMyViewer()]).then(([g, v, me]) => {
      if (cancelled) return
      setGenres(g ?? [])
      setVodTitles(v ?? [])
      let vodHidden = me.disabledVodCategories ?? []
      if (g && v && me.disabledLanguages?.length) {
        const conv = convertLanguages(me.disabledLanguages, g.map((x) => x.name), v)
        const genresHidden = [...new Set([...(me.disabledGenres ?? []), ...conv.genres])]
        vodHidden = [...new Set([...vodHidden, ...conv.vodCategories])]
        setDisabledGenres(new Set(genresHidden))
        setDisabledLanguages(new Set())
        saveFilters({ disabledGenres: genresHidden, disabledVodCategories: vodHidden, disabledLanguages: [] }).catch(saveFailed)
        invalidateChannelCache()
      }
      setHiddenVod(toHiddenMap(vodHidden))
    }).catch(() => { if (!cancelled) { setGenres([]); setVodTitles([]) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per connection
  }, [connected])

  // ── Changes ──────────────────────────────────────────────────────────────
  function toggleAdult(val) {
    setShowAdult(val)
    invalidateChannelCache()
    saveFilters({ showAdult: val }).catch(saveFailed)
  }
  function setLiveHidden(set) {
    setDisabledGenres(set)
    saveFilters({ disabledGenres: [...set] }).catch(saveFailed)
    invalidateChannelCache()
  }
  function liveShow(names, show) {
    const next = new Set(disabledGenres)
    names.forEach((n) => (show ? next.delete(n) : next.add(n)))
    setLiveHidden(next)
  }
  function vodShow(titles, show) {
    const next = new Map(hiddenVod)
    titles.forEach((t) => (show ? next.delete(titleKey(t)) : next.set(titleKey(t), t)))
    setHiddenVod(next)
    saveFilters({ disabledVodCategories: [...next.values()] }).catch(saveFailed)
  }

  // ── Search ───────────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase()
  const shownGenres = useMemo(() => (genres ?? []).filter((g) => !q || g.name.toLowerCase().includes(q)), [genres, q])
  const groups = useMemo(() => groupGenres(shownGenres), [shownGenres])
  const shownVod = useMemo(() => (vodTitles ?? []).filter((t) => !q || t.toLowerCase().includes(q)), [vodTitles, q])

  const liveTotal = genres?.length ?? 0
  const liveShown = (genres ?? []).filter((g) => !disabledGenres.has(g.name)).length
  const vodTotal = vodTitles?.length ?? 0
  const vodShownCount = (vodTitles ?? []).filter((t) => !hiddenVod.has(titleKey(t))).length

  return (
    <>
      <div className="flex items-center justify-between pb-3 mb-1 border-b border-[var(--color-border)]">
        <div>
          <p className="text-sm font-medium text-[var(--color-text)]">Show Adult Content</p>
          <p className="text-xs text-[var(--color-muted)] mt-0.5">Parental lock for categories like &quot;FOR ADULTS&quot;.</p>
        </div>
        <Switch checked={showAdult} onCheckedChange={toggleAdult} />
      </div>

      {!connected ? (
        <p className="text-sm text-[var(--color-muted)]">Connect to a portal to choose which categories you see.</p>
      ) : genres === null || vodTitles === null ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Loader2 size={14} className="animate-spin" /> Loading categories…
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories…"
              aria-label="Search categories"
              className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] pl-7 pr-7 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary-light)] [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)]">
                <X size={13} />
              </button>
            )}
          </div>

          {/* ── Live TV ── */}
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2 pt-2">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Live TV</h3>
              <span className="text-xs text-[var(--color-muted)]">{liveShown} of {liveTotal} categories shown</span>
              <div className="flex-1" />
              {shownGenres.length > 0 && <AllNone onAll={() => liveShow(shownGenres.map((g) => g.name), true)} onNone={() => liveShow(shownGenres.map((g) => g.name), false)} />}
            </div>
            {liveTotal === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">No live TV categories on this portal.</p>
            ) : groups.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">No live TV categories match “{query.trim()}”.</p>
            ) : groups.map(([group, list]) => {
              const names = list.map((g) => g.name)
              const shown = names.filter((n) => !disabledGenres.has(n)).length
              const open = q || !collapsed.has(group)   // a search shows every match
              return (
                <div key={group} className="border-b border-[var(--color-border)] last:border-b-0 py-2.5">
                  <div className="flex items-center gap-2">
                    <button type="button"
                      onClick={() => setCollapsed((prev) => { const n = new Set(prev); n.has(group) ? n.delete(group) : n.add(group); return n })}
                      className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)] hover:text-[var(--color-primary-light)] transition-colors min-w-0">
                      {open ? <ChevronUp size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
                      <span className="truncate">{group}</span>
                    </button>
                    <span className="text-[10px] text-[var(--color-muted)] shrink-0">{shown}/{names.length}</span>
                    <div className="flex-1" />
                    <AllNone onAll={() => liveShow(names, true)} onNone={() => liveShow(names, false)} />
                  </div>
                  {open && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {list.map((g) => (
                        <button key={g.id} type="button" onClick={() => liveShow([g.name], disabledGenres.has(g.name))}
                          className={chip(disabledGenres.has(g.name))} aria-pressed={!disabledGenres.has(g.name)}>
                          {g.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </section>

          {/* ── Movies & Series ── */}
          <section className="flex flex-col gap-2 pt-3 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Movies &amp; Series</h3>
              <span className="text-xs text-[var(--color-muted)]">{vodShownCount} of {vodTotal} shown</span>
              <div className="flex-1" />
              {shownVod.length > 0 && <AllNone onAll={() => vodShow(shownVod, true)} onNone={() => vodShow(shownVod, false)} />}
            </div>
            {vodTotal === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">No movie or series categories (VOD may be turned off, or the portal has none).</p>
            ) : shownVod.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">No movie or series categories match “{query.trim()}”.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {shownVod.map((t) => {
                  const hidden = hiddenVod.has(titleKey(t))
                  return (
                    <button key={t} type="button" onClick={() => vodShow([t], hidden)} className={chip(hidden)} aria-pressed={!hidden}>
                      {t}
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}
