import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/appContext'
import { Switch } from '@/components/ui/switch'
import { getGroups, getAllVodCategories, getMyViewer, saveMyFilters } from '../stalkerApi'
import { invalidateChannelCache } from '../lib/channelCache'
import { getActiveProfileId } from '@/lib/profiles'
import { serialSaves } from '@/lib/serialSaves'
import { showToast } from '@/lib/toast'
import { languageOf, toLanguageSet } from '@/lib/languages'
import { groupGenres, releaseLanguages, titleKey, vodCategoryList } from '@/lib/channelFilters'

// Settings → My channels: what the current viewer sees. Show Adult, the Live TV
// categories (grouped by the part before the "|") and the Movies & Series
// categories, each hideable, with one search across both. Changes show at once
// and are saved in the order made; a failed save puts back what the server has.
//
// An older filter hid whole "languages" (everything whose name starts with
// one). It keeps working — categories the portal adds later in that language
// stay hidden — and is listed here to remove; showing a category it covers
// releases that language and hides the rest of it one by one.

const chip = (hidden) => cn(
  'px-3 py-1.5 rounded-full text-xs font-semibold transition-all border text-left',
  hidden
    ? 'bg-[var(--color-surface-2)] text-[var(--color-muted)] border-[var(--color-border)] opacity-50 line-through'
    : 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)] border-[var(--color-primary)]/30 hover:bg-[var(--color-primary)]/25'
)
const linkBtn = 'text-[10px] font-medium text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors shrink-0'

const toHiddenMap = (list) => new Map((list ?? []).map((t) => [titleKey(t), t]))

// The category lists, kept for the portal connection while Settings switches
// tabs (each switch remounts this). An empty Live TV list is never kept: right
// after connecting the groups may still be loading.
const LISTS_TTL_MS = 5 * 60 * 1000
let listsCache = null   // { profile, at, genres, vodTitles }

async function loadLists() {
  const profile = getActiveProfileId()
  if (listsCache && listsCache.profile === profile && Date.now() - listsCache.at < LISTS_TTL_MS) return listsCache
  const [g, m, s] = await Promise.all([
    getGroups().then((r) => (r.groups ?? []).filter((x) => x.name && x.name.toLowerCase() !== 'all')),
    getAllVodCategories('vod').then((r) => r.categories ?? []).catch(() => []),
    getAllVodCategories('series').then((r) => r.categories ?? []).catch(() => []),
  ])
  const lists = { profile, at: Date.now(), genres: g, vodTitles: vodCategoryList(m, s) }
  if (g.length) listsCache = lists
  return lists
}

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
  const {
    connected, viewer, showAdult, setShowAdult, disabledGenres, setDisabledGenres,
    disabledLanguages, setDisabledLanguages, applyViewer, updateViewerFields,
  } = useApp()
  const [genres, setGenres]       = useState(null)   // live categories, null while loading
  const [vodTitles, setVodTitles] = useState(null)   // movie & series category names
  // Hidden movie & series categories, titleKey() → name. Names no longer on the
  // portal stay saved, in case they come back.
  const [hiddenVod, setHiddenVod] = useState(() => toHiddenMap(viewer?.disabledVodCategories))
  const [query, setQuery]         = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())

  const saveFilters = useMemo(() => serialSaves(saveMyFilters), [])
  function saveFailed() {
    showToast('Could not save your channel filters', 'error')
    getMyViewer().then((me) => { applyViewer(me); setHiddenVod(toHiddenMap(me.disabledVodCategories)) }).catch(() => {})
  }

  // This viewer's hidden movie & series categories — again when the viewer
  // changes while Settings is open (switched, or deleted on the Viewers tab).
  useEffect(() => { setHiddenVod(toHiddenMap(viewer?.disabledVodCategories)) }, [viewer?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The lists. While the portal is still loading its channel groups, try again.
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    let timer = null
    let tries = 0
    const load = () => loadLists().then((l) => {
      if (cancelled) return
      setGenres(l.genres)
      setVodTitles(l.vodTitles)
      if (!l.genres.length && ++tries < 10) timer = setTimeout(load, 3000)
    }).catch(() => { if (!cancelled) { setGenres((g) => g ?? []); setVodTitles((v) => v ?? []) } })
    load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [connected])

  // ── What's hidden ────────────────────────────────────────────────────────
  const oldLanguages = useMemo(() => toLanguageSet([...disabledLanguages]), [disabledLanguages])
  const liveHidden = (name) => disabledGenres.has(name) || oldLanguages.has(languageOf(name))
  const vodHidden = (title) => hiddenVod.has(titleKey(title)) || oldLanguages.has(languageOf(title))

  // ── Changes ──────────────────────────────────────────────────────────────
  function toggleAdult(val) {
    setShowAdult(val)
    invalidateChannelCache()
    saveFilters({ showAdult: val }).catch(saveFailed)
    updateViewerFields({ showAdult: val })
  }

  // One save for any change: what's hidden in each list, and the old languages.
  function apply({ genres: g = disabledGenres, vod = hiddenVod, languages }) {
    const body = {}
    if (g !== disabledGenres) { setDisabledGenres(g); body.disabledGenres = [...g] }
    if (vod !== hiddenVod) { setHiddenVod(vod); body.disabledVodCategories = [...vod.values()] }
    if (languages) { setDisabledLanguages(new Set(languages)); body.disabledLanguages = languages }
    saveFilters(body).catch(saveFailed)
    updateViewerFields(body)
    invalidateChannelCache()
  }

  function show(liveNames, vodNames, visible) {
    const g = new Set(disabledGenres)
    const vod = new Map(hiddenVod)
    liveNames.forEach((n) => (visible ? g.delete(n) : g.add(n)))
    vodNames.forEach((t) => (visible ? vod.delete(titleKey(t)) : vod.set(titleKey(t), t)))
    let languages
    if (visible) {
      const released = releaseLanguages([...liveNames, ...vodNames], oldLanguages, (genres ?? []).map((x) => x.name), vodTitles ?? [])
      if (released) {
        languages = released.languages
        released.hideGenres.forEach((n) => g.add(n))
        released.hideVod.forEach((t) => vod.set(titleKey(t), t))
      }
    }
    apply({ genres: g, vod, languages })
  }
  const liveShow = (names, visible) => show(names, [], visible)
  const vodShow = (titles, visible) => show([], titles, visible)
  const forgetLanguage = (lang) => apply({ languages: [...oldLanguages].filter((l) => l !== lang) })

  // ── Search ───────────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase()
  const shownGenres = useMemo(() => (genres ?? []).filter((g) => !q || g.name.toLowerCase().includes(q)), [genres, q])
  const groups = useMemo(() => groupGenres(shownGenres), [shownGenres])
  const shownVod = useMemo(() => (vodTitles ?? []).filter((t) => !q || t.toLowerCase().includes(q)), [vodTitles, q])

  const liveTotal = genres?.length ?? 0
  const liveShownCount = (genres ?? []).filter((g) => !liveHidden(g.name)).length
  const vodTotal = vodTitles?.length ?? 0
  const vodShownCount = (vodTitles ?? []).filter((t) => !vodHidden(t)).length

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

          {oldLanguages.size > 0 && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3 py-2.5 flex flex-col gap-2">
              <p className="text-xs text-[var(--color-muted)]">
                Also hidden by an older filter — everything whose name starts with these, including categories added later.
                Remove one to show its categories again, or show a single category below.
              </p>
              <div className="flex flex-wrap gap-2">
                {[...oldLanguages].sort().map((lang) => (
                  <button key={lang} type="button" onClick={() => forgetLanguage(lang)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    aria-label={`Stop hiding everything starting with ${lang}`}>
                    {lang} <X size={11} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Live TV ── */}
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2 pt-2">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Live TV</h3>
              <span className="text-xs text-[var(--color-muted)]">{liveShownCount} of {liveTotal} categories shown</span>
              <div className="flex-1" />
              {shownGenres.length > 0 && <AllNone onAll={() => liveShow(shownGenres.map((g) => g.name), true)} onNone={() => liveShow(shownGenres.map((g) => g.name), false)} />}
            </div>
            {liveTotal === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">No live TV categories yet — the portal may still be loading its channels.</p>
            ) : groups.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">No live TV categories match “{query.trim()}”.</p>
            ) : groups.map(([group, list]) => {
              const names = list.map((g) => g.name)
              const shown = names.filter((n) => !liveHidden(n)).length
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
                      {list.map((g) => {
                        const hidden = liveHidden(g.name)
                        return (
                          <button key={g.id} type="button" onClick={() => liveShow([g.name], hidden)}
                            className={chip(hidden)} aria-pressed={!hidden}>
                            {g.name}
                          </button>
                        )
                      })}
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
                  const hidden = vodHidden(t)
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
