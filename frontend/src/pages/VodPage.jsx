import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, Film, Tv2, ChevronLeft, ChevronRight, ChevronDown, Clock, X, Loader2, Play, Download, Check, CheckCircle2, Circle, Bookmark, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import { useApp } from '@/lib/appContext'
import { getVodCategories, getVodItems, getVodSeasons, getVodEpisodes } from '../stalkerApi'
import { getVodHistory, removeFromVodHistory, clearVodHistory, loadWatch, onWatchChange, getWatchedVodIds, getMyList, setMyListCompleted, getWatchState, setEpisodeWatched } from '@/lib/vodProgress'
import { continueTarget, episodeLabel, historyEpisodeLabel, episodeRowLabel, seasonLookupFor, seasonNoOf, watchedInSeason, watchedOfEpisodes, seasonWatchedLabel } from '@/lib/seriesProgress'
import MyListButton from '@/components/MyListButton'
import VodFilters from '@/components/VodFilters'
import { useCategoryListing } from '@/lib/useCategoryListing'
import { NO_FILTERS, filtersActive, applyVodFilters, sortVodItems, filterOptions } from '@/lib/vodFilters'
import { queueDownload } from '@/lib/downloads'
import { showToast } from '@/lib/toast'

// ── Continue Watching row ─────────────────────────────────────────────────
// Horizontally-scrolling shelf of in-progress titles, restored from localStorage.
// ── Recently watched ─────────────────────────────────────────────────────
// The viewer's last titles, newest first (backend viewers/WatchStore.js): a
// show once, with the episode played last. Unfinished ones show how far they
// got, finished ones are ticked. A movie resumes (or plays again); a show opens
// its seasons, at the episode Continue would play.
function RecentlyWatched({ entries, seasonNos = {}, onOpen, onRemove, onClear }) {
  if (!entries.length) return null
  return (
    <section className="mb-6" aria-label="Recently watched">
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Recently watched</h2>
        <button type="button" onClick={onClear} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]">Clear</button>
      </div>
      <div className={TILE_ROW}>
        {entries.map(e => {
          const pct = !e.finished && e.duration > 0 ? Math.min(100, (e.position / e.duration) * 100) : 0
          const episode = historyEpisodeLabel(e, seasonNos)
          return (
            <div key={e.id} className="group relative min-w-0">
              <button
                onClick={() => onOpen(e)}
                aria-label={`${e.finished ? 'Watched' : 'Resume'}: ${e.title}${episode ? `, ${episode}` : ''}`}
                className="block w-full text-left rounded-[var(--radius-sm)] overflow-hidden"
              >
                <div className="relative w-full aspect-[2/3] bg-[var(--color-surface-2)] overflow-hidden rounded-[var(--radius-sm)]">
                  {e.screenshotUrl ? (
                    <img src={e.screenshotUrl} alt="" className="w-full h-full object-contain" loading="lazy" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Film size={24} className="text-[var(--color-muted)] opacity-40" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <Play size={28} className="text-white opacity-0 group-hover:opacity-90 transition-opacity drop-shadow-lg" fill="currentColor" />
                  </div>
                  {e.finished ? (
                    <span className="absolute top-1 left-1 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      <Check size={10} /> Watched
                    </span>
                  ) : pct > 0 && (
                    <div className="absolute bottom-0 inset-x-0 h-1 bg-black/50">
                      <div className="h-full bg-[var(--color-primary-light)]" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <p className="text-xs font-medium text-[var(--color-text)] truncate leading-tight mt-1">{e.title}</p>
                {episode && <p className="text-[11px] text-[var(--color-muted)] truncate leading-tight">{episode}</p>}
              </button>
              <button
                onClick={() => onRemove(e.id)}
                aria-label={`Remove ${e.title} from Recently watched`}
                className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/60 text-white/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/80 hover:text-white transition-all"
              >
                <X size={16} />
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── My List ───────────────────────────────────────────────────────────────
const MY_LIST = { id: 'mylist', title: 'My List' }
// The "All" the server adds to Movies or Series when the portal's own can't be
// shown — some categories hidden, or no series section (backend routes/vod.js).
const COMBINED_ALL_IDS = new Set(['movies:all', 'series:all'])
const isCombinedAllId = (id) => COMBINED_ALL_IDS.has(id)

// The titles to watch, as a row under Recently watched.
function MyListRow({ entries, onOpen, onSeeAll, onDownload }) {
  if (!entries.length) return null
  return (
    <section className="mb-6" aria-label="My List">
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">My List</h2>
        <button type="button" onClick={onSeeAll} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]">See all</button>
      </div>
      <div className={TILE_ROW}>
        {entries.map((e) => (
          <div key={e.id} className="min-w-0">
            <VodCard item={e.item} onClick={onOpen} onDownload={onDownload} />
          </div>
        ))}
      </div>
    </section>
  )
}

// My List as a category: To watch, then Completed. Each title can move
// between the two by hand.
function MyListView({ toWatch, completed, empty, kind, onOpen, onDownload }) {
  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-[var(--color-muted)]">
        <Bookmark size={32} className="opacity-30" />
        <p className="text-sm">No {kind} on My List yet.</p>
        <p className="text-xs">Use the bookmark on any title to save it for later.</p>
      </div>
    )
  }
  const grid = (entries, done) => (
    <div className={TILE_GRID}>
      {entries.map((e) => (
        <div key={e.id} className="flex flex-col gap-1">
          <VodCard item={e.item} onClick={onOpen} onDownload={onDownload} />
          <button
            type="button"
            onClick={() => setMyListCompleted(e.id, !done)}
            className="self-start flex items-center gap-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            {done ? <><RotateCcw size={11} /> Back to To watch</> : <><Check size={11} /> Mark completed</>}
          </button>
        </div>
      ))}
    </div>
  )
  return (
    <div className="flex flex-col gap-8">
      <section aria-label="To watch">
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">To watch <span className="text-[var(--color-muted)] font-normal">{toWatch.length}</span></h2>
        {toWatch.length ? grid(toWatch, false) : <p className="text-xs text-[var(--color-muted)]">Nothing here{completed.length ? ' — all watched.' : '.'}</p>}
      </section>
      {completed.length > 0 && (
        <section aria-label="Completed">
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Completed <span className="text-[var(--color-muted)] font-normal">{completed.length}</span></h2>
          {grid(completed, true)}
        </section>
      )}
    </div>
  )
}

// A history entry's title as a VOD item, rebuilt from the player link it was
// saved with — to open a show's seasons again.
function itemFromParams(params) {
  const q = new URLSearchParams(params)
  const dec = (k) => { const v = q.get(k); try { return v ? decodeURIComponent(v) : '' } catch { return v || '' } }
  return {
    id: q.get('videoId') || '', name: q.get('title') || '', cmd: q.get('cmd') || '',
    year: q.get('year') || '', durationMin: parseInt(q.get('durationMin') || '0', 10) || 0, isHD: q.get('isHD') === 'true',
    screenshotUrl: dec('screenshotUrl'), description: dec('description'), director: dec('director'),
    isSeries: true, episodes: [],
  }
}

// ── Tile sizes ────────────────────────────────────────────────────────────
// Every VOD tile is one column of TILE_GRID wide — in the grid, and in the
// Recently watched and My List rows, which scroll sideways in columns of
// exactly that width (100% less the gaps, over the column count, per
// breakpoint). Keep the two in step.
const TILE_GRID = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-4 sm:gap-5 md:gap-6'
const TILE_ROW = 'grid grid-flow-col gap-4 sm:gap-5 md:gap-6 overflow-x-auto pt-1 pb-3 -mx-1 px-1 ' +
  'auto-cols-[calc((100%_-_1rem)/2)] sm:auto-cols-[calc((100%_-_2.5rem)/3)] md:auto-cols-[calc((100%_-_4.5rem)/4)] ' +
  'lg:auto-cols-[calc((100%_-_6rem)/5)] xl:auto-cols-[calc((100%_-_9rem)/7)]'

// ── Thumbnail component ───────────────────────────────────────────────────
// VOD artwork from these portals is almost always a movie-poster crop (2:3),
// not a 16:9 backdrop — a 16:9 box just letterboxed it with big empty bars.
// object-contain stays (some titles still send oddball aspect ratios), but
// the box itself now matches the common case so it fills edge-to-edge.
function Thumb({ src, name, isHD }) {
  const [err, setErr] = useState(false)
  return (
    <div className="relative w-full aspect-[2/3] bg-[var(--color-surface-2)] rounded-[var(--radius-sm)] overflow-hidden">
      {src && !err ? (
        <img
          src={src}
          alt={name}
          className="w-full h-full object-contain"
          loading="lazy"
          onError={() => setErr(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Film size={28} className="text-[var(--color-muted)] opacity-40" />
        </div>
      )}
      {isHD && (
        <span className="absolute bottom-1 right-1 text-[9px] font-bold px-1 py-0.5 rounded bg-[var(--color-primary)]/80 text-white leading-none">HD</span>
      )}
    </div>
  )
}

// ── VOD item card ─────────────────────────────────────────────────────────
function VodCard({ item, onClick, onDownload }) {
  const hasSeries = item.episodes?.length > 0
  return (
    <button
      onClick={() => onClick(item)}
      className="group w-full min-w-0 text-left flex flex-col gap-1.5 rounded-[var(--radius-md)] overflow-hidden transition-all duration-200 hover:scale-[1.03] hover:shadow-[var(--shadow-lg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary-light)]"
    >
      <div className="relative">
        <Thumb src={item.screenshotUrl} name={item.name} isHD={item.isHD} />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
          <Play size={32} className="text-white opacity-0 group-hover:opacity-90 transition-opacity drop-shadow-lg" fill="currentColor" />
        </div>
        {/* Above the hover shade (z-10), or the shade takes the click and plays the title. */}
        <MyListButton item={item} overlay className="absolute top-1.5 left-1.5 z-10" />
        {!hasSeries && (
          <div
            role="button"
            tabIndex={0}
            title="Download to server"
            onClick={e => { e.stopPropagation(); onDownload(item) }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDownload(item) } }}
            className="absolute top-1.5 right-1.5 z-10 p-2 rounded-full bg-black/60 text-white/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/80 hover:text-white transition-all"
          >
            <Download size={18} />
          </div>
        )}
        {hasSeries && (
          <span className="absolute bottom-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white leading-none">
            {item.episodes.length} ep
          </span>
        )}
      </div>
      <div className="px-0.5">
        <p className="text-xs font-medium text-[var(--color-text)] truncate leading-tight">{item.name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {item.year && <span className="text-[10px] text-[var(--color-muted)]">{item.year}</span>}
          {item.durationMin > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--color-muted)]">
              <Clock size={9} />{item.durationMin}m
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

// ── Categories ────────────────────────────────────────────────────────────
// In the sidebar on tablets and up; on phones in a sheet from the bottom.

function TypeToggle({ vodType, onChange, className }) {
  return (
    <div className={cn('flex gap-1', className)}>
      {[['vod', 'Movies'], ['series', 'Series']].map(([t, label]) => (
        <button
          key={t}
          type="button"
          aria-pressed={vodType === t}
          onClick={() => onChange(t)}
          className={cn(
            'flex-1 text-xs font-medium py-1.5 rounded-[var(--radius-sm)] transition-all',
            vodType === t
              ? 'btn-gradient text-white'
              : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** My List, then the categories. onPick gets 'mylist' or a category. */
function CategoryList({ categories, loading, error, selectedId, myListCount, onPick }) {
  return (
    <>
      {loading && (
        <div className="flex justify-center py-8">
          <Loader2 size={18} className="animate-spin text-[var(--color-primary-light)]" />
        </div>
      )}
      {error && <p className="px-3 py-4 text-xs text-[var(--color-live)] text-center">{error}</p>}
      {!loading && categories.length === 0 && !error && (
        <p className="px-3 py-4 text-xs text-[var(--color-muted)] text-center">No categories found.</p>
      )}
      <button
        type="button"
        onClick={() => onPick('mylist')}
        aria-current={selectedId === MY_LIST.id ? 'true' : undefined}
        className={cn(
          'w-full flex items-center gap-2 text-left px-3 py-2 text-xs transition-colors border-b border-[var(--color-border)]',
          selectedId === MY_LIST.id
            ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)] font-medium'
            : 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
        )}
      >
        <Bookmark size={12} /> My List
        <span className="ml-auto text-[10px] text-[var(--color-muted)]">{myListCount || ''}</span>
      </button>
      {categories.map(cat => (
        <button
          key={cat.id}
          type="button"
          onClick={() => onPick(cat)}
          aria-current={selectedId === cat.id ? 'true' : undefined}
          className={cn(
            'w-full text-left px-3 py-2 text-xs transition-colors',
            selectedId === cat.id
              ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)] font-medium'
              : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
          )}
        >
          {cat.title}
        </button>
      ))}
    </>
  )
}

/** Phones: the category list from the bottom of the screen, the one chosen in view. */
function CategorySheet({ title, onClose, children }) {
  const listRef = useRef(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' })
  }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end md:hidden" role="dialog" aria-modal="true" aria-label={title + ' categories'}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-h-[75dvh] flex flex-col rounded-t-2xl overflow-hidden modal-panel pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <p className="text-sm font-semibold text-[var(--color-text)]">{title}</p>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--color-muted)] hover:text-[var(--color-text)]"><X size={18} /></button>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto py-1 [&>button]:py-3 [&>button]:text-sm">{children}</div>
      </div>
    </div>,
    document.body
  )
}

// ── Seasons / Episodes sheet ──────────────────────────────────────────────
// TV-show drill-down: show → seasons → episodes. Selecting a season fetches its
// episodes; selecting an episode resolves and plays it (passing season/episode
// ids so the backend can drill to the concrete file).
function SeasonsSheet({ item, onClose, onPlayEpisode, onDownloadEpisode, onDownloadSeason }) {
  const [seasons, setSeasons] = useState(null)
  const [selectedSeason, setSelectedSeason] = useState(null)
  const [episodesBySeason, setEpisodesBySeason] = useState({})   // seasonId → episodes, as loaded
  const [seasonErrors, setSeasonErrors] = useState({})          // seasonId → why its episodes didn't load
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [continueFailed, setContinueFailed] = useState(false)  // a season Continue needed didn't load: no Continue, the rest works
  const [watch, setWatch] = useState(() => getWatchState())
  const loadingSeasons = useRef(new Set())
  const picked = useRef(false)     // the viewer chose a season: don't move them

  useEffect(() => onWatchChange(setWatch), [])

  useEffect(() => {
    setLoading(true)
    getVodSeasons(item.id)
      .then(r => { setSeasons(r.seasons || []); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [item.id])

  // One load per season, whoever asks first (Continue or a tap); a failure is
  // that season's alone — the seasons list and the others still work.
  const loadSeason = useCallback((seasonId, forContinue = false) => {
    if (!seasonId || loadingSeasons.current.has(seasonId)) return
    loadingSeasons.current.add(seasonId)
    setSeasonErrors(m => { if (!(seasonId in m)) return m; const rest = { ...m }; delete rest[seasonId]; return rest })
    getVodEpisodes(item.id, seasonId)
      .then(r => setEpisodesBySeason(m => ({ ...m, [seasonId]: r.episodes || [] })))
      .catch(e => {
        loadingSeasons.current.delete(seasonId)
        setSeasonErrors(m => ({ ...m, [seasonId]: e.message || 'Could not load the episodes' }))
        if (forContinue) setContinueFailed(true)
      })
  }, [item.id])

  // What Continue plays — loading the seasons it has to look into.
  const target = seasons ? continueTarget({
    showId: item.id, seasons, episodesBySeason,
    history: watch.history, progress: watch.progress, watchedEpisodes: watch.watchedEpisodes,
  }) : null
  const needs = target?.needs
  useEffect(() => { if (needs) loadSeason(needs, true) }, [needs, loadSeason])
  const next = target && !target.needs && !continueFailed ? target : null

  // Open straight at Continue's season, its episode highlighted. (At the
  // show's end there's nothing to continue: the seasons list shows.)
  useEffect(() => {
    if (!next || picked.current) return
    setSelectedSeason(next.season)
  }, [next?.season?.id, next?.episode?.episodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  function openSeason(season) {
    picked.current = true
    setSelectedSeason(season)
    if (!episodesBySeason[season.id]) loadSeason(season.id)
  }

  const episodes = selectedSeason ? episodesBySeason[selectedSeason.id] : null
  const seasonError = selectedSeason ? seasonErrors[selectedSeason.id] : null
  const waiting = selectedSeason && !episodes && !seasonError
  const continueLabel = next && episodeLabel({ season: seasonNoOf(next.season), episode: next.episode.seriesNumber, name: next.episode.name })

  // Portalled to <body> so no page ancestor (transforms, filters, overflow)
  // can trap the fixed overlay. Solid surface rather than .glass-strong: its 7%
  // fill over a busy poster grid left the episode titles unreadable.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden modal-panel">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          {selectedSeason && (
            <button onClick={() => { picked.current = true; setSelectedSeason(null) }} className="text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors" aria-label="Seasons">
              <ChevronLeft size={18} />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[var(--color-text)] truncate">{item.name}</p>
            <p className="text-xs text-[var(--color-muted)]">
              {selectedSeason ? selectedSeason.name : 'Select a season'}
            </p>
          </div>
          <MyListButton item={item} />
          {selectedSeason && episodes?.length > 0 && (
            <button
              onClick={() => onDownloadSeason(item, selectedSeason, episodes)}
              title="Download whole season"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              <Download size={13} /> Season
            </button>
          )}
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors p-1" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Continue: resume the episode stopped partway, or play the next one not watched */}
        {next && (
          <div className="px-4 py-2.5 border-b border-[var(--color-border)]">
            <button
              onClick={() => onPlayEpisode(item, next.season, next.episode)}
              className="w-full flex items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              <Play size={14} fill="currentColor" />
              <span className="truncate">{next.action === 'resume' ? 'Resume' : 'Play'} {continueLabel}</span>
            </button>
          </div>
        )}

        {/* Content — min-h-0 lets this flex child shrink below its content so
            it scrolls instead of growing the sheet past max-h. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" />
            </div>
          )}
          {error && <p className="px-4 py-6 text-sm text-[var(--color-live)] text-center">{error}</p>}

          {!loading && !error && !selectedSeason && (
            seasons && seasons.length > 0 ? (
              <ul>
                {seasons.map((season, i) => {
                  const listed = episodesBySeason[season.id]
                  const done = listed
                    ? seasonWatchedLabel(watchedOfEpisodes(watch.watchedEpisodes, item.id, season.id, listed), listed.length)
                    : seasonWatchedLabel(watchedInSeason(watch.watchedEpisodes, item.id, season.id), null)
                  return (
                    <li key={season.id || i}>
                      <button
                        onClick={() => openSeason(season)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-2)] transition-colors"
                      >
                        <div className="w-10 h-10 rounded bg-[var(--color-surface-2)] shrink-0 overflow-hidden">
                          {season.screenshotUrl ? (
                            <img src={season.screenshotUrl} alt={season.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Tv2 size={18} className="text-[var(--color-muted)]" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-[var(--color-text)] truncate">{season.name}</p>
                          {done && (
                            <p className="flex items-center gap-1 text-xs text-[var(--color-success)]"><Check size={12} /> {done}</p>
                          )}
                        </div>
                        <ChevronRight size={16} className="text-[var(--color-muted)] shrink-0" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-[var(--color-muted)] text-center">No seasons found.</p>
            )
          )}

          {!loading && !error && selectedSeason && (
            seasonError ? (
              <div className="px-4 py-6 text-center space-y-3">
                <p className="text-sm text-[var(--color-live)]">{seasonError}</p>
                <button onClick={() => loadSeason(selectedSeason.id)} className="text-sm text-[var(--color-primary-light)] hover:underline">Try again</button>
              </div>
            ) : waiting ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" />
              </div>
            ) : (
              <EpisodeList
                showId={item.id}
                season={selectedSeason}
                episodes={episodes}
                watch={watch}
                highlightId={next?.season.id === selectedSeason.id ? next.episode.episodeId : null}
                onPlay={(ep) => onPlayEpisode(item, selectedSeason, ep)}
                onDownload={(ep) => onDownloadEpisode(item, selectedSeason, ep)}
                onTicked={() => { picked.current = true }}
              />
            )
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// A season's episodes: a tick on the watched ones, how far into the started
// ones, Continue's highlighted — and a button to mark one watched or not.
function EpisodeList({ showId, season, episodes, watch, highlightId, onPlay, onDownload, onTicked = () => {} }) {
  if (!episodes || episodes.length === 0) {
    return <p className="px-4 py-6 text-sm text-[var(--color-muted)] text-center">No episodes found.</p>
  }
  const watched = new Set(watch.watchedEpisodes)
  return (
    <ul>
      {episodes.map((ep) => {
        const key = `${showId}:${season.id}:${ep.episodeId}`
        const seen = watched.has(key)
        const point = seen ? null : watch.progress.find((e) => e.key === key)
        const pct = point && point.duration > 0 ? Math.min(100, (point.position / point.duration) * 100) : 0
        const name = episodeRowLabel(ep)
        return (
          <li key={ep.episodeId} className={cn('flex items-center group', ep.episodeId === highlightId && 'bg-[var(--color-primary)]/10')}>
            <button
              onClick={() => onPlay(ep)}
              className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-2)] transition-colors"
            >
              <div className="w-14 h-8 rounded bg-[var(--color-surface-2)] shrink-0 overflow-hidden relative flex items-center justify-center border border-[var(--color-border)]">
                {ep.screenshotUrl ? (
                  <img src={ep.screenshotUrl} alt={ep.name} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <Play size={12} className="text-[var(--color-muted)] group-hover:text-[var(--color-primary-light)] transition-colors" fill="currentColor" />
                )}
                {pct > 0 && (
                  <div className="absolute bottom-0 inset-x-0 h-1 bg-black/50">
                    <div className="h-full bg-[var(--color-primary-light)]" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--color-text)] truncate">{name}</p>
                {seen && <p className="flex items-center gap-1 text-[11px] text-[var(--color-success)]"><Check size={11} /> Watched</p>}
              </div>
            </button>
            <button
              onClick={() => { onTicked(); setEpisodeWatched(key, !seen) }}
              title={seen ? 'Mark as not watched' : 'Mark as watched'}
              aria-label={seen ? `Mark ${name} as not watched` : `Mark ${name} as watched`}
              aria-pressed={seen}
              className={cn('shrink-0 p-2 rounded-md hover:bg-[var(--color-surface-2)] transition-colors',
                seen ? 'text-[var(--color-success)]' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]')}
            >
              {seen ? <CheckCircle2 size={16} /> : <Circle size={16} />}
            </button>
            <button
              onClick={() => onDownload(ep)}
              title="Download to server"
              className="shrink-0 p-2 mr-2 rounded-md text-[var(--color-muted)] hover:text-[var(--color-primary-light)] hover:bg-[var(--color-surface-2)] transition-colors"
            >
              <Download size={14} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// Build URLSearchParams for the VOD player, including metadata for the sidebar.
// extra: { seriesNo, seasonNo, episodeTitle, seasonId, episodeId } for TV-show episodes.
function buildPlayerParams(item, extra = {}) {
  const { seriesNo = 0, seasonNo = '', episodeTitle = '', seasonId = '', episodeId = '' } = extra
  const p = new URLSearchParams({
    videoId: item.id,
    title:   item.name,
    cmd:     item.cmd || '',
    series:  String(seriesNo),
  })
  if (seasonId)          p.set('seasonId', String(seasonId))
  if (episodeId)         p.set('episodeId', String(episodeId))
  if (seasonNo)          p.set('season', String(seasonNo))
  if (episodeTitle)      p.set('episodeTitle', episodeTitle)
  if (item.year)         p.set('year', item.year)
  if (item.durationMin)  p.set('durationMin', String(item.durationMin))
  if (item.isHD)         p.set('isHD', 'true')
  
  const screenshot = extra.screenshotUrl || item.screenshotUrl
  if (screenshot)        p.set('screenshotUrl', encodeURIComponent(screenshot))
  if (item.description)  p.set('description', encodeURIComponent(item.description))
  if (item.director)     p.set('director', encodeURIComponent(item.director))
  if (item.actors)       p.set('actors', encodeURIComponent(item.actors))
  return p
}

// ── Main VOD page ─────────────────────────────────────────────────────────
export default function VodPage() {
  const navigate  = useNavigate()
  const { showAdult, viewer, disabledLanguages } = useApp()
  // The viewer's hidden movie & series categories (Settings → My channels): a
  // change while this page stays open behind Settings reloads the categories.
  const vodFilterKey = JSON.stringify([viewer?.id, viewer?.disabledVodCategories ?? [], [...disabledLanguages].sort()])

  const [vodType, setVodType]         = useState('vod')
  const [categories, setCategories]   = useState([])
  const [catsLoading, setCatsLoading] = useState(true)
  const [catsError, setCatsError]     = useState('')

  const [selectedCategory, setSelectedCategory] = useState(null)
  const [items, setItems]             = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError]   = useState('')
  const [totalItems, setTotalItems]   = useState(0)
  const [, setTotalPages]             = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [hasMore, setHasMore]         = useState(false)

  const [search, setSearch]           = useState('')
  const [catsOpen, setCatsOpen]       = useState(false)   // phones: the category sheet
  const closeCats = useCallback(() => setCatsOpen(false), [])
  const [seriesSheet, setSeriesSheet] = useState(null) // item to show seasons for
  const [history, setHistory] = useState(() => getVodHistory()) // Recently watched
  const [myList, setMyList]   = useState(() => getMyList())     // My List
  // Season numbers for Recently watched entries saved before the season was kept
  // ("showId:seasonId" → number), from each show's seasons — asked once per show.
  const [seasonNos, setSeasonNos] = useState({})
  const seasonsAsked = useRef(new Set())
  useEffect(() => {
    for (const e of history) {
      const show = seasonLookupFor(e)
      if (!show || seasonsAsked.current.has(show)) continue
      seasonsAsked.current.add(show)
      getVodSeasons(show)
        .then((r) => setSeasonNos((m) => ({ ...m, ...Object.fromEntries((r.seasons || []).map((s) => [`${show}:${s.id}`, seasonNoOf(s)])) })))
        .catch(() => seasonsAsked.current.delete(show))
    }
  }, [history])

  const searchTimer = useRef(null)
  // Bumped on every category/search/type change so a slow, stale getVodItems()
  // response can't overwrite the grid after the user already moved on to a
  // different category or search term.
  const itemsTokenRef = useRef(0)
  // Ref (not just the itemsLoading state) so loadMore's guard is checked
  // synchronously — two clicks fired before a re-render lands could otherwise
  // both read the same stale `itemsLoading` value and double-fetch the page.
  const itemsLoadingRef = useRef(false)
  // Infinite scroll: a sentinel under the grid, observed within the grid's own
  // scroll container (not the window — the grid scrolls inside the layout).
  const gridScrollRef = useRef(null)
  const sentinelRef   = useRef(null)

  // Recently watched: fetched fresh when the page opens (this page remounts
  // when returning from the player) and kept in step with every change.
  useEffect(() => {
    const stop = onWatchChange((w) => { setHistory(w.history); setMyList(w.list ?? []) })
    loadWatch()
    return stop
  }, [])

  // A title in Recently watched: a show opens its seasons and episodes (at the
  // episode Continue would play — nothing plays until picked); a movie resumes,
  // or plays again once finished.
  function openHistoryEntry(entry) {
    const isEpisode = /(?:^|&)(?:seasonId|episodeId)=/.test(entry.params)
    if (isEpisode) setSeriesSheet(itemFromParams(entry.params))
    else navigate(`/vod-player?${entry.params}`)
  }

  // Title order: A–Z (the default) or newest first, remembered on this device.
  // A ref too, so a change reloads with the new order straight away.
  const [sort, setSort] = useState(() => { try { return localStorage.getItem('sw:vodSort') === 'added' ? 'added' : 'name' } catch { return 'name' } })
  const sortRef = useRef(sort)

  // Load items when category / search changes
  // Not for My List or an added "All": those aren't portal categories (one
  // is read from the viewer's list, the other whole — see `filtering`), so
  // the search box, the sort buttons and leaving filter mode never page them.
  const loadItems = useCallback(async (catId, q, page, token) => {
    if (!catId) return
    if (catId === MY_LIST.id || isCombinedAllId(catId)) {
      itemsLoadingRef.current = false; setItemsLoading(false); setItemsError('')
      return
    }
    itemsLoadingRef.current = true
    setItemsLoading(true)
    setItemsError('')
    try {
      const r = await getVodItems({ type: vodType, category: catId, page, search: q, sort: sortRef.current })
      if (itemsTokenRef.current !== token) return // superseded by a newer category/search change
      if (page === 1) {
        setItems(r.items)
      } else {
        setItems(prev => [...prev, ...r.items])
      }
      setTotalItems(r.totalItems)
      setTotalPages(r.totalPages)
      setCurrentPage(page)
      setHasMore(page < r.totalPages)
    } catch (e) {
      if (itemsTokenRef.current === token) setItemsError(e.message)
    } finally {
      if (itemsTokenRef.current === token) { itemsLoadingRef.current = false; setItemsLoading(false) }
    }
  }, [vodType])

  function changeSort(next) {
    if (next === sort) return
    sortRef.current = next
    setSort(next)
    try { localStorage.setItem('sw:vodSort', next) } catch { /* not remembered */ }
    if (!selectedCategory) return
    const token = ++itemsTokenRef.current
    setItems([])
    loadItems(selectedCategory.id, search, 1, token)
  }

  // ── Filters (genre, year, rating, added, HD, not watched) ───────────────
  // The portal can't filter, so a filter reads the selected category's whole
  // listing (useCategoryListing) and filters, searches and sorts it here,
  // showing titles as they arrive. Not on "All": that is the whole catalog.
  const SHOW_STEP = 140
  const [filters, setFilters] = useState(NO_FILTERS)
  const [visibleCount, setVisibleCount] = useState(SHOW_STEP)
  // An "All" StalkerWeb adds (Movies or Series, when the portal's own can't be
  // shown) is always read whole (backend routes/vod.js) — and can be filtered,
  // unlike the portal's own "All", which is the whole catalog.
  const isCombinedAll = isCombinedAllId(selectedCategory?.id)
  const isMyList = selectedCategory?.id === MY_LIST.id
  const isAllCategory = !!selectedCategory && !isCombinedAll && (String(selectedCategory.id) === '*' || selectedCategory.title?.trim().toLowerCase() === 'all')
  // Whole-listing mode: a filter is on, or an added "All".
  const filtering = ((filtersActive(filters) && !!selectedCategory && !isAllCategory) || isCombinedAll) && !isMyList
  // My List for this tab (movies or shows): To watch and Completed, each
  // searched, filtered and sorted like any category ('Newest' = added last).
  const tabList = useMemo(() => myList.filter((e) => !!e.item.isSeries === (vodType === 'series')), [myList, vodType])
  const listSection = (done) => {
    const entries = tabList.filter((e) => !!e.completedAt === done)
    const kept = new Set(applyVodFilters(entries.map((e) => e.item), filters, { watched, search }).map((i) => String(i.id)))
    const shown = entries.filter((e) => kept.has(String(e.item.id)))
    if (sort === 'added') return shown
    const order = sortVodItems(shown.map((e) => e.item), 'name').map((i) => String(i.id))
    return order.map((id) => shown.find((e) => String(e.item.id) === id))
  }
  const listing = useCategoryListing(vodType, selectedCategory?.id, filtering)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read again per category, and when filtering starts
  const watched = useMemo(() => getWatchedVodIds(), [filtering, selectedCategory?.id])
  const filtered = useMemo(
    () => (filtering ? sortVodItems(applyVodFilters(listing.items, filters, { watched, search }), sort) : []),
    [filtering, listing.items, filters, watched, search, sort],
  )
  const options = useMemo(() => filterOptions(isMyList ? tabList.map((e) => e.item) : filtering ? listing.items : items), [isMyList, tabList, filtering, listing.items, items])
  useEffect(() => { setVisibleCount(SHOW_STEP) }, [filters, selectedCategory?.id, sort, search])
  const shownItems = filtering ? filtered.slice(0, visibleCount) : items
  // Back from filtering: the page-by-page list catches up with any search
  // typed meanwhile.
  const wasFiltering = useRef(false)
  useEffect(() => {
    if (wasFiltering.current && !filtering && selectedCategory) {
      const token = ++itemsTokenRef.current
      setItems([])
      loadItems(selectedCategory.id, search, 1, token)
    }
    wasFiltering.current = filtering
  }, [filtering]) // eslint-disable-line react-hooks/exhaustive-deps
  const moreToShow = filtering ? filtered.length > visibleCount : hasMore

  // A new category keeps the search typed (searchRef: this callback stays
  // stable). An added "All" is read whole, not page by page.
  const searchRef = useRef('')
  const selectCategory = useCallback((cat) => {
    setSelectedCategory(cat)
    setItems([])
    setCurrentPage(1)
    const token = ++itemsTokenRef.current
    // This loads the new category; leaving filter mode with it mustn't load it again.
    wasFiltering.current = false
    loadItems(cat.id, searchRef.current, 1, token)
  }, [loadItems])

  // Load categories on type change, or when the viewer's filters change
  useEffect(() => {
    itemsTokenRef.current++ // invalidate any in-flight item fetch from the previous type
    setCatsLoading(true)
    setCatsError('')
    setCategories([])
    setSelectedCategory(null)
    setItems([])
    getVodCategories(vodType)
      .then(r => {
        let cats = r.categories || []
        if (!showAdult) cats = cats.filter(c => !isAdult(c.title))
        setCategories(cats)
        setCatsLoading(false)
        // Default to the portal's "All" category so titles load immediately
        // instead of requiring the user to pick a category first. Not an "All"
        // StalkerWeb adds: that reads every category of the tab in full, so it
        // waits to be picked; the first real category opens instead.
        if (cats.length > 0) {
          const real = cats.filter(c => !isCombinedAllId(c.id))
          const allCat = real.find(c => c.id === '*') ||
                         real.find(c => c.title?.trim().toLowerCase() === 'all') ||
                         real[0] || cats[0]
          selectCategory(allCat)
        }
      })
      .catch(e => { setCatsError(e.message); setCatsLoading(false) })
  }, [vodType, showAdult, selectCategory, vodFilterKey])

  function handleSearchChange(q) {
    setSearch(q)
    searchRef.current = q
    clearTimeout(searchTimer.current)
    if (filtering) return   // the whole listing is here: searched as it's typed
    searchTimer.current = setTimeout(() => {
      if (selectedCategory) {
        setItems([])
        setCurrentPage(1)
        const token = ++itemsTokenRef.current
        loadItems(selectedCategory.id, q, 1, token)
      }
    }, 400)
  }

  function loadMore() {
    if (filtering) { setVisibleCount((c) => c + SHOW_STEP); return }
    if (!selectedCategory || !hasMore || itemsLoadingRef.current) return
    loadItems(selectedCategory.id, search, currentPage + 1, itemsTokenRef.current)
  }
  const loadMoreRef = useRef(loadMore)
  useEffect(() => { loadMoreRef.current = loadMore })

  // Load the next batch as the sentinel nears the viewport. The observer is
  // rebuilt whenever a load finishes: an IntersectionObserver only reports
  // changes, so if the new batch didn't push the sentinel off-screen (tall
  // window, short batch) the fresh observer's initial callback keeps going.
  useEffect(() => {
    const root = gridScrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || !moreToShow || (!filtering && (itemsLoading || itemsError))) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some(e => e.isIntersecting)) loadMoreRef.current() },
      { root, rootMargin: '0px 0px 1200px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [moreToShow, filtering, itemsLoading, itemsError, shownItems.length])

  function handleItemClick(item) {
    const hasSeries = item.isSeries || item.episodes?.length > 0
    if (hasSeries) {
      setSeriesSheet(item)
    } else {
      navigate(`/vod-player?${buildPlayerParams(item)}`)
    }
  }

  // show: the show item; season: { id, name }; ep: { episodeId, seriesNumber, name }
  function handlePlayEpisode(show, season, ep) {
    setSeriesSheet(null)
    navigate(`/vod-player?${buildPlayerParams(show, {
      seriesNo:     ep.seriesNumber,
      seasonNo:     seasonNoOf(season),
      seasonId:     season.id,
      episodeId:    ep.episodeId,
      episodeTitle: ep.name || `Episode ${ep.seriesNumber}`,
      screenshotUrl: ep.screenshotUrl || season.screenshotUrl || show.screenshotUrl,
    })}`)
  }

  async function downloadMovie(item) {
    try {
      await queueDownload([{ videoId: item.id, cmd: item.cmd || '', series: 0, title: item.name }])
      showToast(`Queued "${item.name}" for download`, 'success')
    } catch (e) {
      showToast(e.message || 'Could not queue download', 'error')
    }
  }

  async function downloadEpisode(show, season, ep) {
    try {
      await queueDownload([{
        videoId:     show.id,
        cmd:         show.cmd || '',
        series:      ep.seriesNumber,
        seasonId:    season.id,
        episodeId:   ep.episodeId,
        title:       ep.name || `Episode ${ep.seriesNumber}`,
        seriesTitle: show.name,
      }])
      showToast(`Queued "${ep.name || `Episode ${ep.seriesNumber}`}" for download`, 'success')
    } catch (e) {
      showToast(e.message || 'Could not queue download', 'error')
    }
  }

  async function downloadSeason(show, season, episodes) {
    const items = episodes.map(ep => ({
      videoId:     show.id,
      cmd:         show.cmd || '',
      series:      ep.seriesNumber,
      seasonId:    season.id,
      episodeId:   ep.episodeId,
      title:       ep.name || `Episode ${ep.seriesNumber}`,
      seriesTitle: show.name,
    }))
    try {
      await queueDownload(items)
      showToast(`Queued ${items.length} episode${items.length === 1 ? '' : 's'} from "${season.name}"`, 'success')
    } catch (e) {
      showToast(e.message || 'Could not queue season download', 'error')
    }
  }

  const categoryList = (
    <CategoryList
      categories={categories}
      loading={catsLoading}
      error={catsError}
      selectedId={selectedCategory?.id}
      myListCount={tabList.filter((e) => !e.completedAt).length}
      onPick={(cat) => { setCatsOpen(false); selectCategory(cat === 'mylist' ? MY_LIST : cat) }}
    />
  )

  return (
    // dvh: the height left with a phone browser's bars showing (100vh ran under Safari's toolbar).
    <div className="fade-in flex h-[calc(100dvh-3.5rem)] lg:h-dvh">

      {/* ── Left sidebar: categories (tablets and up; phones get the bar below) ── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <TypeToggle vodType={vodType} onChange={setVodType} className="p-2 border-b border-[var(--color-border)]" />
        <div className="flex-1 overflow-y-auto py-1">{categoryList}</div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">

        {/* Phones: Movies/Series and the category on one line; the list opens as a sheet */}
        <div className="md:hidden flex items-center gap-2 px-4 pt-3">
          <TypeToggle vodType={vodType} onChange={setVodType} className="w-40 shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface)] p-0.5" />
          <button
            type="button"
            onClick={() => setCatsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={catsOpen}
            className="flex-1 min-w-0 flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)]"
          >
            {isMyList && <Bookmark size={12} className="shrink-0" />}
            <span className="truncate flex-1 text-left">{selectedCategory?.title || 'Choose a category'}</span>
            <ChevronDown size={14} className="shrink-0 text-[var(--color-muted)]" />
          </button>
        </div>
        {catsOpen && (
          <CategorySheet title={vodType === 'series' ? 'Series' : 'Movies'} onClose={closeCats}>{categoryList}</CategorySheet>
        )}

        {/* Search bar */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none" />
            <input
              placeholder={selectedCategory ? `Search in ${selectedCategory.title}…` : 'Select a category first'}
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              disabled={!selectedCategory}
              className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] pl-8 pr-3 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary-light)] disabled:opacity-40"
            />
          </div>
          {selectedCategory && (
            <span className="hidden sm:inline text-xs text-[var(--color-muted)]">
              {isMyList
                ? `${tabList.length.toLocaleString()} titles`
                : filtering
                ? `${filtered.length.toLocaleString()} of ${listing.loaded.toLocaleString()} titles`
                : totalItems > 0 ? `${totalItems.toLocaleString()} titles` : ''}
            </span>
          )}
          <div role="group" aria-label="Sort titles" className="ml-auto flex shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] p-0.5">
            {[['name', 'A–Z'], ['added', 'Newest']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={sort === id}
                onClick={() => changeSort(id)}
                className={cn(
                  'px-2.5 py-1 rounded-[calc(var(--radius-sm)-2px)] text-xs font-medium transition-colors',
                  sort === id ? 'bg-[var(--color-primary)] text-[var(--color-bg)]' : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <VodFilters
          filters={filters}
          onChange={setFilters}
          options={options}
          disabled={!selectedCategory || isAllCategory}
          note={isAllCategory ? 'Pick a category to filter — "All" is the whole catalog.'
            : listing.error ? listing.error
            : listing.partial ? "Some titles couldn't be read — try again in a few minutes."
            : null}
        />

        {/* Items grid */}
        <div ref={gridScrollRef} className="flex-1 overflow-y-auto p-4">
          {!filtersActive(filters) && !search && !isMyList && (
            <>
              <RecentlyWatched entries={history} seasonNos={seasonNos} onOpen={openHistoryEntry} onRemove={removeFromVodHistory} onClear={clearVodHistory} />
              <MyListRow entries={myList.filter((e) => !e.completedAt)} onOpen={handleItemClick} onSeeAll={() => selectCategory(MY_LIST)} onDownload={downloadMovie} />
            </>
          )}

          {isMyList && (
            <MyListView
              toWatch={listSection(false)}
              completed={listSection(true)}
              empty={tabList.length === 0}
              kind={vodType === 'series' ? 'shows' : 'movies'}
              onOpen={handleItemClick}
              onDownload={downloadMovie}
            />
          )}
          {!selectedCategory && (
            <>
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--color-muted)]">
                <Film size={48} className="opacity-20" />
                <p className="text-sm">Select a category to browse {vodType === 'series' ? 'series' : 'movies'}</p>
              </div>
            </>
          )}

          {itemsError && (
            <p className="text-sm text-[var(--color-live)] text-center py-8">{itemsError}</p>
          )}

          {!isMyList && shownItems.length > 0 && (
            <>
              <div className={TILE_GRID}>
                {shownItems.map(item => (
                  <VodCard key={item.id} item={item} onClick={handleItemClick} onDownload={downloadMovie} />
                ))}
              </div>

              {/* Infinite-scroll sentinel + status. The button stays as a
                  fallback (keyboard / TV remote, or after a failed load). */}
              <div ref={sentinelRef} className="flex items-center justify-center gap-3 mt-6 pb-2">
                {(filtering ? !listing.complete : itemsLoading) && <Loader2 size={18} className="animate-spin text-[var(--color-primary-light)]" />}
                {filtering && !listing.complete && (
                  <p className="text-xs text-[var(--color-muted)]">Reading titles… {listing.loaded.toLocaleString()}{listing.total ? ` of ${listing.total.toLocaleString()}` : ''}</p>
                )}
                {moreToShow && (filtering || !itemsLoading) && (
                  <button
                    onClick={loadMore}
                    className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:bg-[var(--color-primary)]/10 hover:border-[var(--color-primary-light)] transition-colors"
                  >
                    Load more
                  </button>
                )}
                {!filtering && !hasMore && totalItems > 0 && (
                  <p className="text-xs text-[var(--color-muted)]">All {totalItems.toLocaleString()} titles loaded</p>
                )}
              </div>
            </>
          )}

          {filtering && listing.complete && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-[var(--color-muted)]">
              <Film size={32} className="opacity-20" />
              <p className="text-sm">{filtersActive(filters) || search ? 'No titles match.' : 'No titles in this category.'}</p>
            </div>
          )}

          {filtering && !listing.complete && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-[var(--color-muted)]">
              <Loader2 size={28} className="animate-spin text-[var(--color-primary-light)]" />
              <p className="text-xs">Reading titles… {listing.loaded.toLocaleString()}{listing.total ? ` of ${listing.total.toLocaleString()}` : ''}</p>
            </div>
          )}

          {!filtering && !isMyList && selectedCategory && !itemsLoading && items.length === 0 && !itemsError && (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-[var(--color-muted)]">
              <Film size={32} className="opacity-20" />
              <p className="text-sm">{search ? `No results for "${search}"` : 'No titles in this category.'}</p>
            </div>
          )}

          {!filtering && !isMyList && selectedCategory && itemsLoading && items.length === 0 && (
            <div className="flex items-center justify-center h-48">
              <Loader2 size={28} className="animate-spin text-[var(--color-primary-light)]" />
            </div>
          )}
        </div>
      </div>

      {/* Seasons / Episodes sheet */}
      {seriesSheet && (
        <SeasonsSheet
          item={seriesSheet}
          onClose={() => setSeriesSheet(null)}
          onPlayEpisode={handlePlayEpisode}
          onDownloadEpisode={downloadEpisode}
          onDownloadSeason={downloadSeason}
        />
      )}
    </div>
  )
}
