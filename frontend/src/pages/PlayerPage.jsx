import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { isLanguageDisabled } from '../lib/languages'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  List, Search, Loader2, AlertCircle, Tv2, Heart, ChevronDown,
  PictureInPicture2, ChevronLeft, CalendarClock,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import { pushRecentlyWatched } from '@/lib/recentlyWatched'
import { getStreamUrl, streamKeepalive, getProxiedLogoUrl, getNowNext, getChannelEpg } from '../stalkerApi'
import { useApp } from '@/lib/appContext'
import { ChannelLogo } from '@/components/ChannelLogo'
import { useFavorites } from '@/lib/useFavorites'
import { getCachedChannelData, subscribeChannelUpdates } from '@/lib/channelCache'

// ── Controls bar ──────────────────────────────────────────────────────────
function Controls({
  playing, muted, volume, isFullscreen, isPiP, channelName, jumpDigits,
  audioTracks, activeAudio, subtitleTracks, activeSub,
  showGuide, onToggleGuide,
  onPlayPause, onMute, onVolume, onFullscreen, onToggleList, onTogglePiP,
  onAudioTrack, onSubtitleTrack,
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent">
      <div className="flex items-center gap-2">
        <button onClick={onPlayPause} className="text-white/90 hover:text-white transition-colors p-1" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <div className="flex items-center gap-2 group/vol">
          <button onClick={onMute} className="text-white/90 hover:text-white transition-colors p-1">
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <div className="w-0 overflow-hidden group-hover/vol:w-20 group-focus-within/vol:w-20 transition-all duration-200">
            <Slider min={0} max={100} step={1} value={[muted ? 0 : volume]} onValueChange={([v]) => onVolume(v)} className="w-20" />
          </div>
        </div>
        <Badge variant="live" className="ml-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-white animate-pulse" />LIVE</Badge>
      </div>
      <div className="flex-1 text-center">
        <span className="text-sm font-medium text-white/90 truncate">{channelName}</span>
      </div>
      {jumpDigits ? (
        <div className="text-sm font-mono font-bold text-white bg-white/20 rounded px-2 py-0.5 min-w-[2.5rem] text-center">
          {jumpDigits}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-white/50 mr-2 hidden sm:block">
          OK·F·M·P·G·↑↓·←→·0-9
        </div>
      )}
      <div className="flex items-center gap-1">
        {/* Audio track picker */}
        {audioTracks.length > 1 && (
          <select
            value={activeAudio}
            onChange={e => onAudioTrack(Number(e.target.value))}
            className="bg-black/60 text-white/80 text-xs rounded px-1 py-0.5 border border-white/20 cursor-pointer"
            title="Audio track"
          >
            {audioTracks.map((t, i) => (
              <option key={i} value={i}>{t.name || t.lang || `Audio ${i + 1}`}</option>
            ))}
          </select>
        )}
        {/* Subtitle track picker */}
        {subtitleTracks.length > 0 && (
          <select
            value={activeSub}
            onChange={e => onSubtitleTrack(Number(e.target.value))}
            className="bg-black/60 text-white/80 text-xs rounded px-1 py-0.5 border border-white/20 cursor-pointer"
            title="Subtitles"
          >
            <option value={-1}>Off</option>
            {subtitleTracks.map((t, i) => (
              <option key={i} value={i}>{t.name || t.lang || `Sub ${i + 1}`}</option>
            ))}
          </select>
        )}
        {/* PiP button — only shown when browser supports it */}
        {document.pictureInPictureEnabled && (
          <button
            onClick={onTogglePiP}
            className={cn('p-1.5 rounded transition-colors', isPiP ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10')}
            aria-label={isPiP ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
            title="Picture-in-Picture (P)"
          >
            <PictureInPicture2 size={18} />
          </button>
        )}
        <button
          onClick={onToggleGuide}
          className={cn('p-1.5 rounded transition-colors', showGuide ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10')}
          aria-label={showGuide ? 'Hide programme guide' : 'Show programme guide'}
          aria-pressed={showGuide}
          title="Programme guide (G)"
        >
          <CalendarClock size={18} />
        </button>
        <button onClick={onToggleList} className="text-white/80 hover:text-white transition-colors p-1.5 rounded hover:bg-white/10" aria-label="Toggle channel list">
          <List size={18} />
        </button>
        <button onClick={onFullscreen} className="text-white/80 hover:text-white transition-colors p-1.5 rounded hover:bg-white/10" aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
    </div>
  )
}

// ── Now playing guide ─────────────────────────────────────────────────────
// What's on the playing channel: the programme now (with its description and
// progress) and the next two. Its guide is loaded for the next 6 hours when
// the channel changes, and again every 10 minutes.
const clock = (secs) => new Date(secs * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function NowPlayingGuide({ channelId }) {
  const [events, setEvents] = useState(null)
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    if (!channelId) return
    let cancelled = false
    setEvents(null)
    const load = () => getChannelEpg(channelId, 6)
      .then(d => { if (!cancelled) setEvents(d?.events || []) })
      .catch(() => { if (!cancelled) setEvents([]) })
    load()
    const id = setInterval(load, 10 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [channelId])

  // Ticks for the progress bar, and to move on when a programme ends.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 15_000)
    return () => clearInterval(id)
  }, [])

  if (!events) return null
  const idx = events.findIndex(e => e.startTime <= now && now < e.endTime)
  const cur = idx >= 0 ? events[idx] : null
  const later = (idx >= 0 ? events.slice(idx + 1) : events.filter(e => e.startTime > now)).slice(0, 2)
  if (!cur && !later.length) {
    return <p className="mx-4 mb-1 text-xs text-white/50">No guide information for this channel.</p>
  }
  const pct = cur ? Math.min(100, Math.max(0, ((now - cur.startTime) / (cur.endTime - cur.startTime)) * 100)) : 0

  return (
    <div className="mx-3 sm:mx-4 mb-1 flex flex-col sm:flex-row gap-2 sm:gap-4 rounded-[var(--radius-md)] bg-black/55 backdrop-blur-sm px-3 py-2.5 text-white">
      {cur && (
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-live)]">Now</span>
            <span className="text-xs text-white/60 whitespace-nowrap">{clock(cur.startTime)} – {clock(cur.endTime)}</span>
          </div>
          <p className="text-sm font-semibold truncate">{cur.title || 'Untitled'}</p>
          {cur.description && <p className="text-xs text-white/70 line-clamp-2 mt-0.5">{cur.description}</p>}
          <div className="h-1 mt-1.5 rounded-full bg-white/15 overflow-hidden">
            <div className="h-full rounded-full bg-[var(--color-primary-light)]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {later.length > 0 && (
        <div className="sm:w-60 shrink-0 flex flex-col gap-1 sm:border-l sm:border-white/15 sm:pl-4">
          {later.map((e, i) => (
            <div key={e.startTime} className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/50 mr-2">{i === 0 ? 'Next' : 'Later'}</span>
              <span className="text-xs text-white/60">{clock(e.startTime)}</span>
              <p className="text-xs font-medium truncate">{e.title || 'Untitled'}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Virtual list hook ─────────────────────────────────────────────────────
const ROW_H = 48

function useVirtualList(items, containerRef, overscan = 3) {
  const [containerHeight, setContainerHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setContainerHeight(entry.contentRect.height))
    ro.observe(el)
    setContainerHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    setScrollTop(el.scrollTop)
    return () => el.removeEventListener('scroll', onScroll)
  }, [containerRef])

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan)
  const endIndex   = Math.min(items.length - 1, Math.ceil((scrollTop + containerHeight) / ROW_H) + overscan)
  return {
    visibleItems: items.slice(startIndex, endIndex + 1),
    totalHeight:  items.length * ROW_H,
    offsetY:      startIndex * ROW_H,
  }
}

// ── EPG progress bar ──────────────────────────────────────────────────────
function EpgProgress({ epg }) {
  const now = Math.floor(Date.now() / 1000)
  if (!epg?.now?.startTime || !epg?.now?.endTime) return null
  const pct = Math.min(100, Math.max(0,
    ((now - epg.now.startTime) / (epg.now.endTime - epg.now.startTime)) * 100
  ))
  return (
    <div className="h-0.5 w-full bg-[var(--color-border)] rounded-full overflow-hidden mt-0.5">
      <div className="h-full bg-[var(--color-primary-light)] rounded-full" style={{ width: `${pct}%` }} />
    </div>
  )
}

// ── Channel list panel ────────────────────────────────────────────────────
function ChannelList({ channels, activeId, logoMap, favoriteIds, groups, nowNext, onSelect, onToggleFavorite, focusRequest = 0, onLeave }) {
  const [query, setQuery]         = useState('')
  const [activeGroup, setGroup]   = useState('')
  const [favsOnly, setFavsOnly]   = useState(false)
  const scrollRef = useRef(null)

  const filtered = useMemo(() => channels.filter(ch => {
    if (favsOnly && !favoriteIds.has(String(ch.uniqueId))) return false
    if (activeGroup && String(ch.genreId ?? '') !== String(activeGroup)) return false
    if (query && !ch.name?.toLowerCase().includes(query.toLowerCase())) return false
    return true
  }), [channels, favsOnly, favoriteIds, activeGroup, query])

  const { visibleItems, totalHeight, offsetY } = useVirtualList(filtered, scrollRef)

  // Read `filtered` through a ref so the auto-scroll effect can use the current
  // list without depending on it — otherwise it re-fires on every search keystroke
  // or favs/genre change and yanks the view back to the playing channel.
  const filteredRef = useRef(filtered)
  useEffect(() => { filteredRef.current = filtered }, [filtered])

  // Scroll active channel into view only when the active channel itself changes.
  useEffect(() => {
    if (!activeId || !scrollRef.current) return
    const idx = filteredRef.current.findIndex(ch => String(ch.uniqueId) === String(activeId))
    if (idx === -1) return
    const el = scrollRef.current
    const itemTop = idx * ROW_H
    const itemBottom = itemTop + ROW_H
    if (itemTop < el.scrollTop || itemBottom > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: itemTop - el.clientHeight / 2 + ROW_H / 2, behavior: 'smooth' })
    }
  }, [activeId])

  // Moves the highlight to row `idx` (virtualized: scroll it in, then focus it).
  function focusRow(idx) {
    const el = scrollRef.current
    if (!el || idx < 0 || idx >= filteredRef.current.length) return
    const top = idx * ROW_H
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight / 2 + ROW_H / 2
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.querySelector(`[data-row="${idx}"]`)?.focus({ preventScroll: true })
    }))
  }

  // The player asks for the highlight (→ on a remote): put it on the playing channel.
  useEffect(() => {
    if (!focusRequest) return
    const idx = filteredRef.current.findIndex(ch => String(ch.uniqueId) === String(activeId))
    focusRow(Math.max(0, idx))
  }, [focusRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  // ↑/↓ move the highlight through the rows instead of changing channel;
  // ← leaves the list. OK on a row plays it (it's a button).
  function onRowsKeyDown(e) {
    const row = e.target.closest?.('[data-row]')
    if (!row) return
    const idx = Number(row.dataset.row)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      focusRow(idx + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation()
      onLeave?.()
    }
  }

  function selectGroup(id) {
    setGroup(id)
    if (id) setFavsOnly(false)
  }

  function toggleFavsOnly() {
    setFavsOnly(v => !v)
    if (!favsOnly) setGroup('')
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)]">

      {/* ── Search + favs toggle ── */}
      <div className="p-3 pb-2 border-b border-[var(--color-border)] flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none" />
            <input
              placeholder="Search…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] pl-7 pr-3 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary-light)]"
            />
          </div>
          <button
            onClick={toggleFavsOnly}
            title={favsOnly ? 'Show all channels' : 'Show favorites only'}
            className={cn(
              'shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-[var(--radius-sm)] border text-xs font-medium transition-colors',
              favsOnly
                ? 'bg-rose-500/15 border-rose-500/40 text-rose-400'
                : 'bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]'
            )}
          >
            <Heart size={11} fill={favsOnly ? 'currentColor' : 'none'} />
            Favs
          </button>
        </div>

        {/* ── Genre dropdown ── */}
        {groups.length > 0 && (
          <div className="relative">
            <select
              value={activeGroup}
              onChange={e => selectGroup(e.target.value)}
              className="w-full appearance-none rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] pl-2.5 pr-7 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)] cursor-pointer"
            >
              <option value="">All Genres</option>
              {groups.map(g => (
                <option key={g.id} value={String(g.id)}>{g.name}</option>
              ))}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
          </div>
        )}
      </div>

      {/* ── Channel rows (virtualized) ── */}
      {/* overflow-anchor:none — stop the browser's scroll anchoring from fighting
          virtualization (rows mount/unmount as we scroll), which otherwise sends
          scrollTop into an oscillation when auto-scrolling to the active channel. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto [overflow-anchor:none]" onKeyDown={onRowsKeyDown}>
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--color-muted)] text-center">
            {favsOnly ? 'No favorites in this view.' : 'No channels found.'}
          </p>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleItems.map((ch, i) => {
                const rowIndex = Math.round(offsetY / ROW_H) + i
                const isFav   = favoriteIds.has(String(ch.uniqueId))
                const epg     = nowNext?.[String(ch.uniqueId)]
                const isActive = String(ch.uniqueId) === String(activeId)
                return (
                  <div
                    key={ch.uniqueId}
                    style={{ height: ROW_H }}
                    className={cn('group flex items-center gap-2 px-2 transition-colors overflow-hidden',
                      isActive
                        ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary-light)]'
                        : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
                    )}
                  >
                    {/* Channel number bubble */}
                    {ch.number > 0 && (
                      <span className={cn(
                        'shrink-0 text-[10px] font-mono font-semibold rounded px-1 py-0.5 min-w-[1.75rem] text-center leading-none',
                        isActive
                          ? 'bg-[var(--color-primary)]/30 text-[var(--color-primary-light)]'
                          : 'bg-[var(--color-surface-2)] text-[var(--color-muted)]'
                      )}>
                        {ch.number}
                      </span>
                    )}
                    <button data-row={rowIndex} className="flex items-center gap-2 flex-1 text-left min-w-0 h-full rounded-[var(--radius-sm)]" onClick={() => onSelect(ch)}>
                      <ChannelLogo src={logoMap[String(ch.uniqueId)] || getProxiedLogoUrl(ch.iconPath)} name={ch.name} size="xs" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs truncate leading-tight">{ch.name}</p>
                        {epg?.now?.title && (
                          <p className="text-[10px] text-[var(--color-muted)] truncate leading-tight opacity-75">{epg.now.title}</p>
                        )}
                        <EpgProgress epg={epg} />
                      </div>
                    </button>
                    <button
                      onClick={() => onToggleFavorite(ch)}
                      className={cn('shrink-0 p-0.5 rounded transition-colors', isFav ? 'text-rose-500' : 'text-[var(--color-muted)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 hover:text-rose-400')}
                    >
                      <Heart size={12} fill={isFav ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Persisted player prefs ────────────────────────────────────────────────
function loadPlayerPrefs() {
  try {
    const s = localStorage.getItem('playerPrefs')
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

function savePlayerPrefs(patch) {
  try {
    const prev = loadPlayerPrefs()
    localStorage.setItem('playerPrefs', JSON.stringify({ ...prev, ...patch }))
  } catch { /* storage full or blocked */ }
}

// Phone-width screens: the channel list goes over the video instead of beside it.
const NARROW = '(max-width: 767px)'
const isNarrowNow = () => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches
function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrowNow)
  useEffect(() => {
    const m = window.matchMedia?.(NARROW)
    if (!m) return
    const onChange = (e) => setNarrow(e.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])
  return narrow
}

// Remote "back" keys: Backspace, and the Back key of LG (webOS) and Samsung (Tizen) TVs.
const isBackKey = (e) => e.key === 'Backspace' || e.key === 'GoBack' || e.key === 'XF86Back' || e.keyCode === 461 || e.keyCode === 10009

// ── Player page ───────────────────────────────────────────────────────────
export default function PlayerPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  // Back to the page the player was opened from. Changing channels replaces
  // the history entry (selectChannel), so one step back is always that page;
  // opened directly (a bookmark, a reload), there is none — go to Channels.
  const goBack = () => (location.key === 'default' ? navigate('/channels') : navigate(-1))
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  const initChannelId   = searchParams.get('channel')
  const initChannelName = searchParams.get('name') ? decodeURIComponent(searchParams.get('name')) : ''

  const videoRef     = useRef(null)
  const hlsRef       = useRef(null)
  const mpegtsRef    = useRef(null)
  const containerRef = useRef(null)
  const hideTimer    = useRef(null)
  const retryCount   = useRef(0)
  // Distinct from retryCount (loadStream's own stream-URL-fetch retry) — hls.js
  // error recovery has its own independent allowances so consuming one doesn't
  // starve the others, which previously let a single shared counter cause an
  // endless reconnect loop on some misclassified/extensionless streams.
  const mediaErrorRetryRef  = useRef(0)
  const hlsFallbackTriedRef = useRef(false)
  const networkErrorRetriedRef = useRef(false)
  // Mid-playback auto-recovery: live links/tokens expire and CDN/ffmpeg pipes
  // drop, which used to freeze playback until a manual browser refresh. These
  // drive a re-attach (fresh create_link server-side) without user action.
  const reconnectAttempts = useRef(0)
  const MAX_RECONNECT_ATTEMPTS = 8
  const recoveringRef     = useRef(false)

  const [rawData, setRawData]         = useState(null)
  const [channels, setChannels]       = useState([])
  const [groups, setGroups]           = useState([])
  const [logoMap, setLogoMap]         = useState({})
  const [nowNext, setNowNext]         = useState({})
  const { showAdult, disabledGenres, disabledLanguages }  = useApp()
  const { favoriteIds, toggleFavorite } = useFavorites()

  const prefs = useMemo(() => loadPlayerPrefs(), [])

  const [muted, setMuted]           = useState(false)
  const [volume, setVolume]         = useState(prefs.volume ?? 80)
  const channelsRef      = useRef([])
  const activeChannelRef = useRef(null)
  const selectChannelRef = useRef(null)
  const volumeRef        = useRef(volume)
  // The user's EXPLICIT mute preference (default: unmuted). Distinct from the
  // temporary mute the browser forces on us to satisfy autoplay — that one must
  // never carry over to the next channel, which is what made playback "always
  // start muted" once any channel hit the autoplay fallback.
  const userMutedRef     = useRef(muted)

  // Restore last-watched channel: URL param takes priority, then localStorage
  const [activeChannel, setActiveChannel] = useState(() => {
    if (initChannelId) return { uniqueId: initChannelId, name: initChannelName }
    if (prefs.lastChannelId) return { uniqueId: prefs.lastChannelId, name: prefs.lastChannelName || '' }
    return null
  })

  const [streamUrl, setStreamUrl]   = useState(null)
  const [streamType, setStreamType] = useState('hls')
  // Bumped to force the player to re-attach (and the proxy to re-resolve a fresh
  // link) without changing streamUrl — used by auto-recovery below.
  const [reloadKey, setReloadKey]   = useState(0)
  const [status, setStatus]         = useState('idle')
  const [errorMsg, setErrorMsg]     = useState('')
  const [showControls, setShowControls] = useState(true)
  const narrow = useNarrow()
  // Starts closed on a phone, where it covers the video; elsewhere as last left.
  const [showList, setShowList]     = useState(() => (isNarrowNow() ? false : (prefs.showList ?? true)))
  const [listFocus, setListFocus]   = useState(0)   // bump to put the highlight in the list
  const [showGuide, setShowGuide]   = useState(prefs.showGuide ?? true)
  const lastPointer = useRef('mouse')
  const [playing, setPlaying]       = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPiP, setIsPiP]           = useState(false)
  const [audioTracks, setAudioTracks]     = useState([])
  const [activeAudio, setActiveAudio]     = useState(0)
  const [subtitleTracks, setSubtitleTracks] = useState([])
  const [activeSub, setActiveSub]         = useState(-1)

  // Channel number jump
  const [jumpDigits, setJumpDigits] = useState('')
  const jumpTimer                   = useRef(null)

  useEffect(() => { channelsRef.current = channels }, [channels])
  useEffect(() => { activeChannelRef.current = activeChannel }, [activeChannel])

  // Persist volume changes
  useEffect(() => { volumeRef.current = volume; savePlayerPrefs({ volume }) }, [volume])

  // Persist sidebar visibility
  useEffect(() => { if (!isNarrowNow()) savePlayerPrefs({ showList }) }, [showList])
  useEffect(() => { savePlayerPrefs({ showGuide }) }, [showGuide])

  // Fetch now/next EPG and refresh it periodically so the sidebar's "now
  // playing" titles and progress bars don't freeze during a long session.
  useEffect(() => {
    let cancelled = false
    const refresh = () => getNowNext().then(d => { if (!cancelled) setNowNext(d) }).catch(() => {})
    refresh()
    const id = setInterval(refresh, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Effect: fetch initial (partial) data + subscribe to full-data updates
  useEffect(() => {
    let cancelled = false
    getCachedChannelData().then(d => { if (!cancelled) setRawData(d) }).catch(() => {})
    const unsub = subscribeChannelUpdates(d => { if (!cancelled) setRawData(d) })
    return () => { cancelled = true; unsub() }
  }, [])

  // Effect: re-apply filters whenever raw data or filter settings change
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

  // Bumped on every new channel selection so a slow, stale getStreamUrl()
  // response (e.g. from a channel the user already navigated away from) can
  // never overwrite state for whatever channel is active by the time it
  // resolves — without this, rapid channel-switching could briefly (or, if
  // the newer request's own response is further delayed, persistently) play
  // the wrong channel's stream.
  const loadTokenRef = useRef(0)

  // loadStream as a proper useCallback so deps are explicit
  const loadStream = useCallback(async (channelId, isRetry = false, token) => {
    setStatus('loading')
    setErrorMsg('')
    try {
      const { streamUrl: url, streamType: type } = await getStreamUrl(channelId)
      if (loadTokenRef.current !== token) return // superseded by a newer channel switch
      setStreamType(type || 'hls')
      setStreamUrl(url)
      const ch = channels.find(c => String(c.uniqueId) === String(channelId)) || activeChannel
      if (ch) pushRecentlyWatched(ch, logoMap[String(ch.uniqueId)])
    } catch (e) {
      if (loadTokenRef.current !== token) return
      if (!isRetry && retryCount.current < 1) {
        retryCount.current++
        setErrorMsg('Stream unavailable, retrying…')
        setTimeout(() => loadStreamRef.current(channelId, true, token), 2000)
      } else {
        setStatus('error')
        setErrorMsg(e.message)
      }
    }
  }, [channels, activeChannel, logoMap])

  const loadStreamRef = useRef(loadStream)
  useEffect(() => { loadStreamRef.current = loadStream }, [loadStream])

  useEffect(() => {
    if (!activeChannel?.uniqueId) return
    retryCount.current = 0
    reconnectAttempts.current = 0
    recoveringRef.current = false
    const token = ++loadTokenRef.current
    loadStreamRef.current(activeChannel.uniqueId, false, token)
  }, [activeChannel?.uniqueId])

  // Re-attach the player after a mid-playback drop or stall. Bumps reloadKey so
  // the attach effect re-runs and hits /proxy/stream again — the server then
  // resolves a fresh create_link (new token / CDN host), exactly like a manual
  // page refresh, but transparently and with exponential backoff.
  const recoverStream = useCallback(() => {
    if (recoveringRef.current) return
    if (typeof document !== 'undefined' && document.hidden) return // don't fight background-pause
    if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
      // A permanently dead link (portal removed it, account expired) would
      // otherwise retry every ~15s forever with no way for the user to tell
      // the difference from a normal transient drop. Give up and surface an
      // error instead — the Retry button resets the counter.
      setStatus('error')
      setErrorMsg('Lost connection to this channel. Try again or pick another channel.')
      return
    }
    recoveringRef.current = true
    reconnectAttempts.current++
    const delay = Math.min(1500 * 2 ** (reconnectAttempts.current - 1), 15000)
    setStatus('loading')
    setErrorMsg('Connection lost — reconnecting…')
    setTimeout(() => {
      recoveringRef.current = false
      setReloadKey(k => k + 1)
    }, delay)
  }, [])

  // Attach HLS when streamUrl changes
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return
    const video = videoRef.current

    const teardown = () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
      if (mpegtsRef.current) { try { mpegtsRef.current.destroy() } catch { /* already gone */ } mpegtsRef.current = null }
    }
    teardown()

    // Fresh allowances for this attach — each is independent so consuming one
    // (e.g. a network-error retry) never starves the others.
    mediaErrorRetryRef.current = 0
    hlsFallbackTriedRef.current = false
    networkErrorRetriedRef.current = false

    // Once media actually flows, clear the recovery state so the next drop gets
    // a fresh backoff sequence. 'playing' also fires when playback resumes after
    // re-buffering, which is exactly when we want to consider recovery done.
    const onPlaying = () => { reconnectAttempts.current = 0; recoveringRef.current = false }
    // For the live engines, the upstream pipe closing surfaces as 'ended' — treat
    // it as a drop and reconnect rather than stopping. ('native' is progressive,
    // where 'ended' is a real end-of-file, so it's excluded.)
    const onEnded = () => { if (streamType === 'mpegts' || streamType === 'hls') recoverStream() }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('ended', onEnded)

    // Reset tracks on every new stream
    setAudioTracks([]); setActiveAudio(0); setSubtitleTracks([]); setActiveSub(-1)
    // Each new channel starts from the user's explicit mute preference (default:
    // unmuted) — never from a previous channel's forced-for-autoplay mute.
    setMuted(userMutedRef.current)

    const tryPlay = () =>
      video.play()
        .then(() => { setStatus('playing'); setPlaying(true) })
        .catch(() => {
          // Unmuted autoplay was blocked (no user activation yet). Start muted so
          // the stream isn't stuck — but do NOT persist this as a preference.
          video.muted = true
          return video.play()
            .then(() => {
              setStatus('playing'); setPlaying(true)
              // Restore sound unless the user explicitly muted, provided the page
              // has had user interaction (so unmuting won't be blocked/re-paused).
              if (!userMutedRef.current && navigator.userActivation?.hasBeenActive) {
                video.muted = false
                setMuted(false)
              } else {
                setMuted(true) // honestly reflect the forced mute for this channel
              }
            })
            .catch(() => { setStatus('paused'); setPlaying(false) })
        })

    const playNative = (src) => {
      video.src = src
      video.volume = volumeRef.current / 100
      video.muted = userMutedRef.current
      tryPlay()
    }

    // Raw MPEG-TS over HTTP — what a STB feeds straight into ffmpeg. mpegts.js
    // demuxes it in the browser via MSE.
    const playMpegts = (src) => {
      if (!mpegts.isSupported()) { setStatus('error'); setErrorMsg('This stream format is not supported by your browser.'); return }
      const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: src },
        // enableWorker:false — worker-mode demuxing has been seen to fail silently
        // (MediaSource opens, but the loader never issues its network fetch and
        // no error event fires), leaving playback stuck with no diagnosable cause.
        // Main-thread demuxing is slightly heavier but far more reliable here.
        // liveBufferLatencyChasing:false — it seeks forward whenever the buffer
        // grows, trading a couple seconds of latency for lower stall risk; on a
        // jittery upstream that constant chasing itself shows up as stutter/restart.
        // A few extra seconds of delay is a fine trade for smooth live-TV playback.
        { enableWorker: false, liveBufferLatencyChasing: false, lazyLoad: false }
      )
      mpegtsRef.current = player
      player.attachMediaElement(video)
      player.on(mpegts.Events.ERROR, (type, detail, info) => {
        console.error('[mpegts] playback error', type, detail, info)
        // A live MPEG-TS pipe dropped (token/CDN/ffmpeg) — reconnect with a fresh
        // link instead of dead-ending until a manual refresh.
        recoverStream()
      })
      player.load()
      video.volume = volumeRef.current / 100
      video.muted = userMutedRef.current
      tryPlay()
    }

    const playHls = (src) => {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true })
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.volume = volumeRef.current / 100
          video.muted = userMutedRef.current
          // Populate audio & subtitle track selectors
          if (hls.audioTracks?.length > 1) { setAudioTracks(hls.audioTracks); setActiveAudio(hls.audioTrack) }
          if (hls.subtitleTracks?.length > 0) { setSubtitleTracks(hls.subtitleTracks); setActiveSub(hls.subtitleTrack) }
          tryPlay()
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return

          // The server answered with an HTTP error — almost always the CDN
          // rejecting an expired stream token (proxied back as 502). Retrying
          // the same URL can't help, and it's a real HLS stream so the mpegts.js
          // fallback below would loop. Reconnect: re-attaching hits
          // /proxy/stream again, which calls create_link for a fresh token.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.response?.code >= 400) {
            hls.destroy()
            hlsRef.current = null
            recoverStream()
            return
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !networkErrorRetriedRef.current) {
            // A transient network blip (manifest/segment timeout) on a real HLS
            // stream — retry loading before assuming anything more drastic.
            // Previously this fell straight into the "not a valid playlist, try
            // mpegts.js" branch below, which destroys a perfectly good Hls
            // instance to attempt mpegts.js against a genuine .m3u8 URL.
            networkErrorRetriedRef.current = true
            hls.startLoad()
            return
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrorRetryRef.current < 1) {
            mediaErrorRetryRef.current++
            hls.recoverMediaError()
          } else if (!hlsFallbackTriedRef.current) {
            hlsFallbackTriedRef.current = true
            // Not a valid HLS playlist — the server may be piping raw MPEG-TS
            // (extensionless link misclassified as HLS). Fall back to mpegts.js.
            hls.destroy()
            hlsRef.current = null
            // Keep streamType in sync so a later recoverStream()-triggered
            // re-attach picks mpegts.js directly instead of retrying playHls
            // and hitting this same fallback in a loop.
            setStreamType('mpegts')
            playMpegts(src)
          } else {
            // Live playlist/segment expired or the connection dropped —
            // reconnect with a fresh create_link rather than stopping.
            recoverStream()
          }
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        playNative(src)
      }
    }

    // Pick the engine from the server's stream-type hint (resolved via create_link).
    if (streamType === 'unsupported') {
      setStatus('error')
      setErrorMsg('This channel uses a protocol (UDP/RTP/RTSP) that browsers can’t play directly.')
    } else if (streamType === 'native') {
      playNative(streamUrl)
    } else if (streamType === 'mpegts') {
      playMpegts(streamUrl)
    } else {
      playHls(streamUrl)
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('ended', onEnded)
      teardown()
    }
  }, [streamUrl, streamType, reloadKey, recoverStream])

  // Stall watchdog: a frozen live stream frequently emits no error at all (the
  // MSE buffer just stops, or the upstream silently closes). If the playback
  // clock stops advancing while we believe we're playing, reconnect.
  useEffect(() => {
    if (status !== 'playing') return
    const video = videoRef.current
    if (!video) return
    let lastTime = video.currentTime
    let lastAdvance = Date.now()
    const id = setInterval(() => {
      if (document.hidden || video.paused || recoveringRef.current) {
        lastTime = video.currentTime; lastAdvance = Date.now(); return
      }
      if (video.currentTime > lastTime + 0.25) {
        lastTime = video.currentTime; lastAdvance = Date.now(); return
      }
      if (Date.now() - lastAdvance > 12000) recoverStream()
    }, 4000)
    return () => clearInterval(id)
  }, [status, recoverStream])

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.volume = volume / 100
    videoRef.current.muted = muted
  }, [volume, muted])

  // Auto-hide controls
  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShowControls(false), 3000)
  }, [])

  useEffect(() => { resetHideTimer(); return () => clearTimeout(hideTimer.current) }, [resetHideTimer])

  // Fullscreen sync
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // PiP sync
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const enter = () => setIsPiP(true)
    const leave = () => setIsPiP(false)
    v.addEventListener('enterpictureinpicture', enter)
    v.addEventListener('leavepictureinpicture', leave)
    return () => { v.removeEventListener('enterpictureinpicture', enter); v.removeEventListener('leavepictureinpicture', leave) }
  }, [])

  // Keepalive — ping backend every 10 minutes while playing to prevent idle disconnect.
  // Belt-and-braces: the proxy stream heartbeat already holds the session open
  // during playback, whatever idle timeout is configured in Settings.
  useEffect(() => {
    if (status !== 'playing') return
    const id = setInterval(() => { streamKeepalive().catch(() => {}) }, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [status])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
      resetHideTimer()   // a remote has no mouse: any key brings the controls up

      if (isBackKey(e)) {
        e.preventDefault()
        goBackRef.current()
        return
      }
      // OK / Enter: on a focused button it presses the button; otherwise play/pause.
      if (e.key === 'Enter') {
        if (e.target.closest?.('button, a, [role="button"]')) return
        e.preventDefault()
        togglePlayPause()
        return
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        setShowList(true)
        setListFocus(n => n + 1)
        return
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        setShowList(false)
        return
      }

      // Digit keys: channel number jump
      if (/^\d$/.test(e.key)) {
        e.preventDefault()
        setJumpDigits(prev => {
          const next = (prev + e.key).slice(-4)
          clearTimeout(jumpTimer.current)
          jumpTimer.current = setTimeout(() => {
            const num = parseInt(next, 10)
            const ch = channelsRef.current.find(c => c.number === num)
            if (ch) selectChannelRef.current(ch)
            setJumpDigits('')
          }, 1200)
          return next
        })
        return
      }

      if (e.key === 'Escape') {
        setJumpDigits('')
        clearTimeout(jumpTimer.current)
        return
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          togglePlayPause()
          break
        case 'KeyF':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'KeyM':
          e.preventDefault()
          setMuted(m => { const nm = !m; userMutedRef.current = nm; return nm })
          break
        case 'KeyP':
          e.preventDefault()
          togglePiP()
          break
        case 'KeyG':
          e.preventDefault()
          setShowGuide(v => !v)
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          const delta = e.code === 'ArrowUp' ? -1 : 1
          const list  = channelsRef.current
          const cur   = activeChannelRef.current
          if (!list.length) break
          const idx  = cur ? list.findIndex(c => String(c.uniqueId) === String(cur.uniqueId)) : -1
          const next = list[(idx + delta + list.length) % list.length]
          if (next) selectChannelRef.current(next)
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(jumpTimer.current) }
  }, [resetHideTimer])

  function togglePlayPause() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play()
        .then(() => { setPlaying(true); setStatus('playing') })
        .catch(() => {
          v.muted = true
          v.play()
            .then(() => { setPlaying(true); setStatus('playing') })
            .catch(() => {})
        })
    } else {
      v.pause()
      setPlaying(false)
      setStatus('paused')
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen()
    else document.exitFullscreen()
  }

  async function togglePiP() {
    if (!videoRef.current) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await videoRef.current.requestPictureInPicture()
    } catch { /* PiP not supported or denied */ }
  }

  function setAudioTrack(idx) {
    setActiveAudio(idx)
    if (hlsRef.current) hlsRef.current.audioTrack = idx
  }

  function setSubtitleTrack(idx) {
    setActiveSub(idx)
    if (hlsRef.current) hlsRef.current.subtitleTrack = idx
  }

  function selectChannel(ch) {
    if (isNarrowNow()) setShowList(false)
    setActiveChannel(ch)
    setSearchParams({ channel: ch.uniqueId, name: encodeURIComponent(ch.name) }, { replace: true })
    savePlayerPrefs({ lastChannelId: String(ch.uniqueId), lastChannelName: ch.name })
  }
  selectChannelRef.current = selectChannel

  return (
    <div className="relative flex h-[calc(100dvh-3.5rem)] lg:h-dvh bg-black">
      <div
        ref={containerRef}
        tabIndex={-1}
        className="relative flex-1 flex items-center justify-center bg-black outline-none"
        onMouseMove={(e) => { if (lastPointer.current === 'mouse' && e.movementX + e.movementY !== 0) resetHideTimer() }}
        onMouseLeave={() => clearTimeout(hideTimer.current)}
        onPointerDown={(e) => { lastPointer.current = e.pointerType || 'mouse' }}
        onClick={() => {
          // On a touch screen the first tap only brings the controls up.
          if (lastPointer.current !== 'mouse' && !showControls && status === 'playing') { resetHideTimer(); return }
          resetHideTimer()
          togglePlayPause()
        }}
      >
        <video ref={videoRef} className="w-full h-full object-contain" playsInline />

        {/* Top bar: back to where the player was opened from. Shown with the controls. */}
        <div
          className={cn(
            'absolute top-0 inset-x-0 z-20 flex items-center px-3 py-2 bg-black/45 backdrop-blur-sm transition-opacity duration-300',
            showControls || status !== 'playing' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-sm text-white/85 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Back"
          >
            <ChevronLeft size={18} />
            Back
          </button>
        </div>

        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Loader2 size={40} className="text-[var(--color-primary-light)] animate-spin" />
            {errorMsg && <p className="absolute mt-16 text-xs text-white/60">{errorMsg}</p>}
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
            <AlertCircle size={40} className="text-[var(--color-live)]" />
            <p className="text-sm text-white/80">{errorMsg}</p>
            {activeChannel && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  retryCount.current = 0
                  reconnectAttempts.current = 0
                  loadStream(activeChannel.uniqueId, false, ++loadTokenRef.current)
                }}
                className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] text-sm hover:bg-[var(--color-primary-hover)] transition-colors"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {status === 'paused' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="rounded-full bg-black/40 backdrop-blur-sm ring-1 ring-white/15 p-6 shadow-[0_0_48px_-8px_var(--color-primary-glow)]">
              <Play size={40} className="text-white" fill="currentColor" />
            </div>
          </div>
        )}

        {status === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Tv2 size={48} className="text-[var(--color-muted)]" />
            <p className="text-sm text-[var(--color-muted)]">Select a channel to start watching</p>
          </div>
        )}

        <div
          className={cn('absolute bottom-0 inset-x-0 transition-opacity duration-300', showControls || status !== 'playing' ? 'opacity-100' : 'opacity-0 pointer-events-none')}
          onClick={e => e.stopPropagation()}
        >
          {showGuide && activeChannel && (status === 'playing' || status === 'paused') && (
            <NowPlayingGuide channelId={activeChannel.uniqueId} />
          )}
          <Controls
            showGuide={showGuide} onToggleGuide={() => setShowGuide(v => !v)}
            playing={playing} muted={muted} volume={volume} isFullscreen={isFullscreen} isPiP={isPiP}
            channelName={activeChannel?.name || initChannelName || 'No channel selected'}
            jumpDigits={jumpDigits}
            audioTracks={audioTracks} activeAudio={activeAudio}
            subtitleTracks={subtitleTracks} activeSub={activeSub}
            onPlayPause={togglePlayPause}
            onMute={() => setMuted(m => { const nm = !m; userMutedRef.current = nm; return nm })}
            onVolume={(v) => { setVolume(v); setMuted(false); userMutedRef.current = false }}
            onFullscreen={toggleFullscreen}
            onToggleList={() => setShowList(v => !v)}
            onTogglePiP={togglePiP}
            onAudioTrack={setAudioTrack}
            onSubtitleTrack={setSubtitleTrack}
          />
        </div>
      </div>

      {narrow ? (
        showList && channels.length > 0 && (
          <>
            <div className="absolute inset-0 z-30 bg-black/50" onClick={() => setShowList(false)} />
            <div className="absolute inset-y-0 right-0 z-40 w-[85%] max-w-xs shadow-2xl">
              <ChannelList
                channels={channels} activeId={activeChannel?.uniqueId}
                logoMap={logoMap} favoriteIds={favoriteIds}
                groups={groups} nowNext={nowNext}
                onSelect={selectChannel} onToggleFavorite={toggleFavorite}
                focusRequest={listFocus} onLeave={() => { setShowList(false); containerRef.current?.focus() }}
              />
            </div>
          </>
        )
      ) : (
        <div className={cn('transition-all duration-300 overflow-hidden shrink-0', showList ? 'w-72' : 'w-0')}>
          {channels.length > 0 && (
            <ChannelList
              channels={channels} activeId={activeChannel?.uniqueId}
              logoMap={logoMap} favoriteIds={favoriteIds}
              groups={groups} nowNext={nowNext}
              onSelect={selectChannel} onToggleFavorite={toggleFavorite}
              focusRequest={listFocus} onLeave={() => { setShowList(false); containerRef.current?.focus() }}
            />
          )}
        </div>
      )}
    </div>
  )
}
