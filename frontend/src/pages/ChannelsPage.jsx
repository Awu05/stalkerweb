import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue, useLayoutEffect, memo } from 'react'
import { isLanguageDisabled } from '../lib/languages'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, Tv2, AlertCircle, AlertTriangle, RefreshCw, Heart, Clock, X, Image, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import { SkeletonGrid } from '@/components/ui/skeleton'
import { getChannelProgress, getProxiedLogoUrl, getNowNext, addLogoOverride, getLogoMap, getChannelHealth } from '../stalkerApi'
import { getRecentlyWatched, removeRecentlyWatched } from '@/lib/recentlyWatched'
import { useApp } from '@/lib/appContext'
import { getCachedChannelData, subscribeChannelUpdates } from '@/lib/channelCache'
import { useFavorites } from '@/lib/useFavorites'

// Channels with at least this many recent (unresolved) stream errors are "flaky".
const FLAKY_THRESHOLD = 2

// Grid geometry — mirrors the old `repeat(auto-fill, minmax(160px,1fr))` + gap-3
// so the virtualizer reproduces the same responsive column layout.
const GRID_GAP     = 12   // px (Tailwind gap-3 = 0.75rem)
const MIN_COL      = 160  // px (minmax(160px, 1fr))
const ROW_ESTIMATE = 210  // px initial row-height guess; dynamic measurement refines it

// Above this many genre pills, the row is collapsed to a single line by default
// so it can't crowd out the channel grid below it.
const GENRE_COLLAPSE_THRESHOLD = 12

function healthTitle(errors) {
  return `${errors} recent stream ${errors === 1 ? 'failure' : 'failures'} — may not play`
}

// ── Channel card ──────────────────────────────────────────────────────────
// Memoized: with thousands of channels rendered through the virtualizer, the
// grid re-renders on every scroll tick and on health/now-next polls. memo +
// stable callback props keep all but the genuinely-changed cards from
// re-rendering.
const ChannelCard = memo(function ChannelCard({ channel, logoUrl, isFavorite, onToggleFavorite, onClick, onSetLogo, compact, nowNext, health }) {
  const [imgError, setImgError] = useState(false)
  const logo = logoUrl || getProxiedLogoUrl(channel.iconPath) || ''
  const errors = health?.errors || 0

  const epgProgress = nowNext?.now
    ? Math.min(100, Math.round(((Math.floor(Date.now() / 1000) - nowNext.now.startTime) /
        (nowNext.now.endTime - nowNext.now.startTime)) * 100))
    : 0

  if (compact) {
    return (
      <button
        onClick={() => onClick(channel)}
        className="surface-card group relative flex flex-col items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)] p-2.5 text-left hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-2)] cursor-pointer w-20 shrink-0"
      >
        {errors > 0 && (
          <span className="absolute top-1 left-1 z-10 text-amber-400" title={healthTitle(errors)}>
            <AlertTriangle size={11} fill="currentColor" className="drop-shadow" />
          </span>
        )}
        <div className="relative group/logo flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] overflow-hidden">
          {logo && !imgError
            ? <img src={logo} alt={channel.name} loading="lazy" onError={() => setImgError(true)} className="h-full w-full object-contain p-0.5" />
            : <Tv2 size={18} className="text-[var(--color-muted)]" />}
          {onSetLogo && (
            <button
              onClick={e => { e.stopPropagation(); onSetLogo(channel) }}
              className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover/logo:opacity-100 transition-opacity"
              aria-label="Set logo"
            >
              <Image size={12} className="text-white" />
            </button>
          )}
        </div>
        <p className="text-[10px] font-medium text-[var(--color-text)] leading-tight text-center break-words line-clamp-2 w-full">{channel.name}</p>
      </button>
    )
  }

  return (
    <button
      onClick={() => onClick(channel)}
      className="surface-card group relative flex flex-col items-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)] p-4 text-left hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-2)] cursor-pointer"
    >
      <button
        onClick={e => { e.stopPropagation(); onToggleFavorite(channel) }}
        className={cn('absolute top-2 right-2 p-1 rounded transition-colors',
          isFavorite ? 'text-rose-500' : 'text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-rose-400')}
        aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Heart size={14} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>
      {errors > 0 && (
        <span
          className={cn('absolute top-2 left-2 flex items-center gap-1 text-[10px] font-medium',
            errors >= FLAKY_THRESHOLD ? 'text-amber-400' : 'text-amber-400/70')}
          title={healthTitle(errors)}
        >
          <AlertTriangle size={12} fill="currentColor" />
        </span>
      )}
      <div className="relative group/logo flex h-16 w-16 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] overflow-hidden">
        {logo && !imgError
          ? <img src={logo} alt={channel.name} loading="lazy" onError={() => setImgError(true)} className="h-full w-full object-contain p-1" />
          : <Tv2 size={28} className="text-[var(--color-muted)]" />}
        {onSetLogo && (
          <button
            onClick={e => { e.stopPropagation(); onSetLogo(channel) }}
            className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover/logo:opacity-100 transition-opacity"
            aria-label="Set logo"
          >
            <Image size={16} className="text-white" />
          </button>
        )}
      </div>
      <div className="w-full text-center">
        <p className="text-xs text-[var(--color-muted)] mb-0.5">Ch {channel.number}</p>
        <p className="text-sm font-medium text-[var(--color-text)] leading-tight break-words">{channel.name}</p>
      </div>
      {nowNext?.now && (
        <div className="w-full mt-0.5 pt-2 border-t border-[var(--color-border)]">
          <p className="text-[10px] font-medium text-[var(--color-primary-light)] leading-tight truncate text-left">{nowNext.now.title}</p>
          <div className="mt-1.5 h-[3px] w-full rounded-full bg-[var(--color-surface-3)] overflow-hidden">
            <div className="h-full rounded-full bg-[var(--color-primary)] transition-none" style={{ width: `${epgProgress}%` }} />
          </div>
          {nowNext.next && (
            <p className="mt-1 text-[9px] text-[var(--color-muted)] truncate text-left">Next: {nowNext.next.title}</p>
          )}
        </div>
      )}
    </button>
  )
})

// ── Number jump overlay ───────────────────────────────────────────────────
function NumberJumpOverlay({ digits }) {
  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-1 pointer-events-none">
      <div className="rounded-[var(--radius-md)] bg-black/80 border border-[var(--color-border)] px-6 py-3 text-center backdrop-blur-sm">
        <p className="text-xs text-[var(--color-muted)] mb-1">Jump to channel</p>
        <p className="text-3xl font-bold font-mono text-[var(--color-primary-light)] tracking-widest">{digits}</p>
      </div>
    </div>
  )
}

// ── Channel-load progress bar ─────────────────────────────────────────────
// Owns its own 800ms progress polling so the frequent ticks re-render ONLY this
// small bar, never the (potentially huge) channel grid above it.
function ChannelLoadProgress({ active, onDone }) {
  const [p, setP] = useState(null)
  useEffect(() => {
    if (!active) { setP(null); return }
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const prog = await getChannelProgress()
        if (cancelled) return
        setP(prog)
        if (prog.loading) timer = setTimeout(poll, 800)
        else onDone?.()
      } catch { /* progress polling is best-effort */ }
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, onDone])

  if (!active || !p?.loading || !p.totalPages) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
        <span>Loading channels…</span>
        <span>{p.page} / {p.totalPages} pages · {p.channelCount} channels</span>
      </div>
      <div className="h-1 w-full rounded-full bg-[var(--color-surface-2)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-500"
          style={{ width: `${Math.round((p.page / p.totalPages) * 100)}%` }}
        />
      </div>
    </div>
  )
}

export default function ChannelsPage() {
  const navigate = useNavigate()
  const { showAdult, disabledGenres, disabledLanguages } = useApp()
  const [searchParams, setSearchParams] = useSearchParams()

  const [rawData, setRawData]         = useState(null) // unfiltered snapshot from cache
  const [channels, setChannels]       = useState([])
  const [groups, setGroups]           = useState([])
  const [logoMap, setLogoMap]         = useState({})
  const { favoriteIds, toggleFavorite } = useFavorites()
  const [loading, setLoading]         = useState(true)  // true only before first data arrives
  const [error, setError]             = useState(null)
  const [backendLoading, setBackendLoading] = useState(false) // backend still paging in channels
  const [recentlyWatched, setRecentlyWatched] = useState([])
  const [nowNext, setNowNext] = useState({})
  const [health, setHealth] = useState({})        // { uniqueId: { errors, lastError } }
  const [hideFlaky, setHideFlaky] = useState(false)
  const [genresExpanded, setGenresExpanded] = useState(false)

  // Logo assignment modal
  const [logoChannel, setLogoChannel] = useState(null)
  const [logoUrl, setLogoUrl]         = useState('')
  const [logoSaving, setLogoSaving]   = useState(false)
  const [logoSearch, setLogoSearch]   = useState('')
  const [logoResult, setLogoResult]   = useState(null)

  // Channel number jump
  const [jumpDigits, setJumpDigits]   = useState('')
  const jumpTimer                     = useRef(null)

  const activeGroup = searchParams.get('group') || ''
  const [query, setQuery] = useState('')
  // Deferred so typing stays snappy: the (large) grid re-filters off the
  // deferred value while the input itself updates immediately.
  const deferredQuery = useDeferredValue(query)
  const pillsRef = useRef(null)

  // Virtualized-grid plumbing
  const scrollRef  = useRef(null)   // the scrolling content viewport
  const contentRef = useRef(null)   // wrapper around all scrollable content (resizes as it loads)
  const listRef    = useRef(null)   // the virtualized grid container
  const [gridWidth, setGridWidth]       = useState(0)
  const [scrollMargin, setScrollMargin] = useState(0)

  useEffect(() => {
    const el = pillsRef.current
    if (!el) return
    const onWheel = e => { e.preventDefault(); el.scrollLeft += e.deltaY }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    setRecentlyWatched(getRecentlyWatched())
  }, [])

  // Fetch now/next EPG and refresh it periodically so "now playing" titles
  // and progress bars don't freeze during a long-lived session.
  useEffect(() => {
    let cancelled = false
    const refresh = () => getNowNext().then(d => { if (!cancelled) setNowNext(d) }).catch(() => {})
    refresh()
    const id = setInterval(refresh, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Poll channel stream-health and refresh periodically (it self-heals on success).
  useEffect(() => {
    let cancelled = false
    const refresh = () => getChannelHealth().then(h => { if (!cancelled) setHealth(h || {}) }).catch(() => {})
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Effect 1: fetch initial (possibly partial) data + subscribe to incremental
  // updates. Runs once on mount. The subscription fires every time the backend
  // pages in more channels — not just once at the very end — so the grid fills
  // in page-by-page instead of sitting empty until the whole load finishes.
  useEffect(() => {
    let cancelled = false

    getCachedChannelData()
      .then(data => {
        if (cancelled) return
        setRawData(data)
        setLoading(false)
        if (data.loading) setBackendLoading(true)  // ChannelLoadProgress tracks the rest
      })
      .catch(err => {
        if (cancelled) return
        setError(err.message)
        setLoading(false)
      })

    // Subscribe so the grid updates as each page of channels lands, and only
    // clears the "still loading" flag once the backend is actually done.
    const unsub = subscribeChannelUpdates(data => {
      if (cancelled) return
      setRawData(data)
      setBackendLoading(data.loading)
    })

    return () => { cancelled = true; unsub() }
  }, [])

  const handleLoadDone = useCallback(() => setBackendLoading(false), [])

  // Effect 2: re-apply adult/genre filters whenever raw data or filter settings change.
  useEffect(() => {
    if (!rawData) return
    let ch = rawData.channels
    let gr = rawData.groups.filter(g => g.name?.toLowerCase() !== 'all')

    if (!showAdult) {
      ch = ch.filter(c => !isAdult(c.genre) && !isAdult(c.name))
      gr = gr.filter(g => !isAdult(g.name))
    }

    if (disabledGenres.size > 0) {
      ch = ch.filter(c => !c.genre || !disabledGenres.has(c.genre))
      gr = gr.filter(g => !disabledGenres.has(g.name))
    }

    // Coarser than the genre filter and independent of it: hides every genre of
    // a language at once, and is the same list VOD categories are filtered by.
    if (disabledLanguages.size > 0) {
      ch = ch.filter(c => !c.genre || !isLanguageDisabled(c.genre, disabledLanguages))
      gr = gr.filter(g => !isLanguageDisabled(g.name, disabledLanguages))
    }

    setChannels(ch)
    setGroups(gr)
    setLogoMap(rawData.logoMap)
  }, [rawData, showAdult, disabledGenres, disabledLanguages])

  const openChannel = useCallback((channel) => {
    navigate(`/player?channel=${channel.uniqueId}&name=${encodeURIComponent(channel.name)}`)
  }, [navigate])

  // Stable callbacks passed to every (memoized) ChannelCard so the cards don't
  // re-render just because the page did. toggleFavorite is read through a ref
  // because useFavorites returns a fresh function each render.
  const toggleFavoriteRef = useRef(toggleFavorite)
  toggleFavoriteRef.current = toggleFavorite
  const handleToggleFavorite = useCallback((ch) => toggleFavoriteRef.current(ch), [])
  const handleSetLogo = useCallback((ch) => {
    setLogoChannel(ch); setLogoUrl(''); setLogoSearch(ch.name); setLogoResult(null)
  }, [])

  // ── Keyboard: channel number jump ────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') { setJumpDigits(''); clearTimeout(jumpTimer.current); return }
      if (!/^\d$/.test(e.key)) return

      setJumpDigits(prev => {
        const next = (prev + e.key).slice(-4) // max 4 digits
        clearTimeout(jumpTimer.current)
        jumpTimer.current = setTimeout(() => {
          const num = parseInt(next, 10)
          const ch = channels.find(c => c.number === num)
          if (ch) openChannel(ch)
          setJumpDigits('')
        }, 1200)
        return next
      })
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(jumpTimer.current) }
  }, [channels, openChannel])

  function removeRecentChannel(uniqueId) {
    removeRecentlyWatched(uniqueId)
    setRecentlyWatched(prev => prev.filter(c => String(c.uniqueId) !== String(uniqueId)))
  }

  async function handleSaveLogo() {
    if (!logoChannel || !logoUrl.trim()) return
    setLogoSaving(true)
    try {
      await addLogoOverride(logoChannel.name, logoUrl.trim())
      const map = await getLogoMap()
      setLogoMap(map)
      setLogoChannel(null)
      setLogoUrl(''); setLogoSearch(''); setLogoResult(null)
    } catch { /* best effort */ }
    setLogoSaving(false)
  }

  const logoSearchTimer = useRef(null)
  function onLogoSearchChange(val) {
    setLogoSearch(val)
    setLogoResult(null)
    clearTimeout(logoSearchTimer.current)
    if (!val.trim()) return
    logoSearchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/logos/check?name=${encodeURIComponent(val.trim())}`)
        const data = await r.json()
        setLogoResult(data)
      } catch { /* ignore */ }
    }, 400)
  }

  // Base filter (group + search) — independent of health so the 60s health
  // poll doesn't re-run it over the whole list.
  const baseFiltered = useMemo(() => {
    let result = channels
    if (activeGroup) result = result.filter(c => String(c.genreId ?? '') === String(activeGroup))
    const q = deferredQuery.trim().toLowerCase()
    if (q) result = result.filter(c => c.name?.toLowerCase().includes(q))
    return result
  }, [channels, activeGroup, deferredQuery])

  // Flaky filter layered on top — only depends on health when actually hiding.
  const filtered = useMemo(() => {
    if (!hideFlaky) return baseFiltered
    return baseFiltered.filter(c => (health[String(c.uniqueId)]?.errors || 0) < FLAKY_THRESHOLD)
  }, [baseFiltered, hideFlaky, health])

  const flakyCount = useMemo(
    () => channels.reduce((n, c) => n + ((health[String(c.uniqueId)]?.errors || 0) >= FLAKY_THRESHOLD ? 1 : 0), 0),
    [channels, health]
  )

  function selectGroup(id) {
    setQuery('')
    if (id) setSearchParams({ group: id })
    else setSearchParams({})
  }

  // Enrich recently watched with current logoMap
  const recentChannels = useMemo(() =>
    recentlyWatched.map(r => ({
      ...r,
      logoUrl: logoMap[r.uniqueId] || r.logo,
    })).slice(0, 10),
    [recentlyWatched, logoMap]
  )

  // ── Virtualized grid ──────────────────────────────────────────────────────
  const showGrid = !loading && !error && filtered.length > 0
  const columns  = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (MIN_COL + GRID_GAP)))
  const rowCount = Math.ceil(filtered.length / columns)

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 6,
    scrollMargin,
  })

  // Track the grid's width (→ responsive column count) and its offset within the
  // shared scroll viewport (→ scrollMargin, so rows sit below the Recently-Watched
  // / progress sections). A ResizeObserver on the content wrapper catches late
  // layout shifts such as recently-watched thumbnails finishing loading.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current
    const contentEl = contentRef.current
    const listEl = listRef.current
    if (!scrollEl || !contentEl || !listEl) return
    const measure = () => {
      const w = listEl.clientWidth
      setGridWidth(prev => (Math.abs(prev - w) > 0.5 ? w : prev))
      const top = listEl.getBoundingClientRect().top
        - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      setScrollMargin(prev => (Math.abs(prev - top) > 1 ? top : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(contentEl)
    ro.observe(listEl)
    return () => ro.disconnect()
  }, [showGrid])

  // Row composition changes with column count, so reset cached row heights.
  useEffect(() => { rowVirtualizer.measure() }, [columns, rowVirtualizer])

  return (
    <div className="fade-in flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Number jump overlay */}
      {jumpDigits && <NumberJumpOverlay digits={jumpDigits} />}

      {/* Sticky filter bar */}
      <div className="sticky top-14 z-30 bg-[var(--color-bg)]/90 backdrop-blur-sm border-b border-[var(--color-border)] px-6 py-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none" />
            <Input placeholder="Search channels…" value={query} onChange={e => setQuery(e.target.value)} className="pl-9 py-5" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {flakyCount > 0 && (
              <button
                onClick={() => setHideFlaky(v => !v)}
                title={hideFlaky ? 'Show all channels' : `Hide ${flakyCount} channel${flakyCount === 1 ? '' : 's'} with recent stream failures`}
                className={cn('flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-medium border transition-colors',
                  hideFlaky
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                    : 'bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]')}
              >
                <AlertTriangle size={13} fill={hideFlaky ? 'currentColor' : 'none'} />
                {hideFlaky ? 'Flaky hidden' : `Hide flaky (${flakyCount})`}
              </button>
            )}
            <span className="text-sm font-medium text-[var(--color-muted)] bg-[var(--color-surface-2)] px-3 py-1 rounded-md">
              {filtered.length} {filtered.length === 1 ? 'channel' : 'channels'}
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <div className={cn('flex flex-wrap items-center gap-2 flex-1 min-w-0', !genresExpanded && 'max-h-9 overflow-hidden')}>
            <button
              onClick={() => selectGroup('')}
              className={cn('px-4 py-1.5 rounded-full text-sm font-semibold transition-all',
                !activeGroup ? 'btn-gradient text-white' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]')}
            >All</button>
            {groups.map(g => (
              <button key={g.id} onClick={() => selectGroup(g.id)}
                className={cn('px-4 py-1.5 rounded-full text-sm font-semibold transition-all whitespace-nowrap',
                  activeGroup === String(g.id) ? 'btn-gradient text-white' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]')}
              >{g.name}</button>
            ))}
          </div>
          {groups.length > GENRE_COLLAPSE_THRESHOLD && (
            <button
              onClick={() => setGenresExpanded(v => !v)}
              title={genresExpanded ? 'Collapse genres' : 'Show all genres'}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              {genresExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {genresExpanded ? 'Less' : 'More'}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
       <div ref={contentRef} className="flex flex-col gap-6">

        {/* Recently watched */}
        {recentChannels.length > 0 && !query && (
          <section>
            <div className="flex items-center gap-2 mb-1">
              <Clock size={14} className="text-[var(--color-muted)]" />
              <span className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">Recently Watched</span>
            </div>
            {/* overflow-x-auto also clips vertically, which cut off the card hover
                lift, the remove button (sits above the corner) and the hover glow.
                Padding gives them room inside the clip box; the matching negative
                margin keeps the strip aligned with the grid below. */}
            <div className="flex gap-2 overflow-x-auto scrollbar-none pt-2 pb-3 px-2 -mx-2">
              {recentChannels.map(r => (
                <div key={r.uniqueId} className="relative group/recent shrink-0">
                  <ChannelCard
                    channel={{ uniqueId: r.uniqueId, name: r.name, number: r.number }}
                    logoUrl={r.logoUrl}
                    isFavorite={favoriteIds.has(String(r.uniqueId))}
                    onToggleFavorite={handleToggleFavorite}
                    onClick={openChannel}
                    onSetLogo={handleSetLogo}
                    compact
                    health={health[String(r.uniqueId)]}
                  />
                  <button
                    onClick={() => removeRecentChannel(r.uniqueId)}
                    className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center w-4 h-4 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-border)] text-[var(--color-muted)] opacity-0 group-hover/recent:opacity-100 hover:!opacity-100 hover:text-[var(--color-text)] transition-opacity"
                    aria-label="Remove from recently watched"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Skeleton — only while waiting for the very first response */}
        {loading && (
          <SkeletonGrid count={12} />
        )}

        {/* Progress bar — self-polls so its frequent ticks don't re-render the grid */}
        {!loading && <ChannelLoadProgress active={backendLoading} onDone={handleLoadDone} />}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center gap-3 h-48 text-center">
            <AlertCircle size={32} className="text-[var(--color-live)]" />
            <p className="text-sm text-[var(--color-muted)]">{error}</p>
            <Button variant="outline" size="sm" onClick={() => setSearchParams({})}>
              <RefreshCw size={14} /> Retry
            </Button>
          </div>
        )}

        {/* Empty state — only shown when loading is truly complete with no results */}
        {!loading && !backendLoading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 h-48 text-center">
            <Tv2 size={32} className="text-[var(--color-muted)]" />
            <p className="text-sm text-[var(--color-muted)]">No channels found.</p>
          </div>
        )}

        {/* Channel grid — virtualized: only the visible rows are mounted, so the
            DOM stays tiny no matter how many thousands of channels load. */}
        {showGrid && (
          <div ref={listRef} style={{ position: 'relative', width: '100%', height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map(vRow => {
              const start = vRow.index * columns
              const rowItems = filtered.slice(start, start + columns)
              return (
                <div
                  key={vRow.key}
                  data-index={vRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    transform: `translateY(${vRow.start - rowVirtualizer.options.scrollMargin}px)`,
                    display: 'grid',
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    gap: `${GRID_GAP}px`,
                    paddingBottom: `${GRID_GAP}px`,
                  }}
                >
                  {rowItems.map(ch => (
                    <ChannelCard
                      key={ch.uniqueId} channel={ch}
                      logoUrl={logoMap[String(ch.uniqueId)]}
                      isFavorite={favoriteIds.has(String(ch.uniqueId))}
                      onToggleFavorite={handleToggleFavorite}
                      onClick={openChannel}
                      onSetLogo={handleSetLogo}
                      nowNext={nowNext[String(ch.uniqueId)]}
                      health={health[String(ch.uniqueId)]}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
       </div>
      </div>

      {/* Logo assignment modal */}
      {logoChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setLogoChannel(null)}>
          <div className="modal-panel rounded-xl w-full max-w-sm mx-4 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Set Logo — {logoChannel.name}</h3>
              <button onClick={() => setLogoChannel(null)} className="text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Search by channel name */}
            <div className="mb-3">
              <p className="text-xs text-[var(--color-muted)] mb-1.5">Search by channel name</p>
              <Input
                placeholder={logoChannel.name}
                value={logoSearch}
                onChange={e => onLogoSearchChange(e.target.value)}
                className="text-xs"
                autoFocus
              />
            </div>

            {/* Resolved logo from iptv-org */}
            {logoResult?.logo && (
              <button
                type="button"
                onClick={() => setLogoUrl(logoResult.logo)}
                className={cn(
                  'w-full flex items-center gap-3 p-2.5 rounded-lg border text-left transition-all mb-3',
                  logoUrl === logoResult.logo
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                    : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-2)]'
                )}
              >
                <img src={logoResult.logo} alt="" className="h-10 w-10 rounded object-contain bg-[var(--color-surface-2)] p-1" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[var(--color-text)] truncate">{logoResult.name}</p>
                  <p className="text-[10px] text-[var(--color-muted)] truncate">{logoResult.logo}</p>
                </div>
                {logoUrl === logoResult.logo && <Check size={14} className="text-[var(--color-primary)] shrink-0" />}
              </button>
            )}

            {/* Manual URL input */}
            <div className="flex gap-2">
              <Input
                placeholder="Or paste a logo URL"
                value={logoUrl}
                onChange={e => setLogoUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveLogo() }}
                className="text-xs flex-1"
              />
              <Button
                onClick={handleSaveLogo}
                disabled={!logoUrl.trim() || logoSaving}
                className="shrink-0 h-9 px-4 text-xs"
              >
                {logoSaving ? <RefreshCw size={14} className="animate-spin" /> : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
