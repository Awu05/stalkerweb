import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Play, X, Bell, BellOff, Tv2, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import { isLanguageDisabled } from '@/lib/languages'
import { matchesStation } from '@/lib/stationSearch'
import { useApp } from '@/lib/appContext'
import { getCachedChannelData, subscribeChannelUpdates } from '@/lib/channelCache'
import { getChannelEpg, getProxiedLogoUrl } from '../stalkerApi'
import { useReminders } from '@/lib/useReminders'

// ── Constants ─────────────────────────────────────────────────────────────────
const CHANNEL_COL_WIDTH = 220   // px — sticky left column
const CHANNEL_COL_WIDTH_SM = 132 // px — on phones
const HOUR_WIDTH = 280          // px — 1 hour = 280px → 30min = 140px
const SLOT_MINS = 30            // time column slot width in minutes
const SLOT_WIDTH = SLOT_MINS * (HOUR_WIDTH / 60)
const PAST_HOURS = 2            // hours before now to show
const FUTURE_HOURS = 12         // hours after now to show
const TOTAL_HOURS = PAST_HOURS + FUTURE_HOURS  // 14h window
const ROW_HEIGHT = 64           // px
const HEADER_HEIGHT = 36        // px
const OVERSCAN_ROWS = 8         // rows rendered (and their guide fetched) beyond the visible ones
const MIN_TEXT_WIDTH = 28       // px — narrower blocks show no text, only a tooltip

// Tailwind's `sm` breakpoint is 40rem; a rem query matches it at any browser
// font size, where a px one would disagree with the `sm:` classes.
const SMALL_SCREEN = '(max-width: 39.99rem)'
function useChannelColWidth() {
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(SMALL_SCREEN).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(SMALL_SCREEN)
    if (!mq) return
    const onChange = e => setSmall(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return small ? CHANNEL_COL_WIDTH_SM : CHANNEL_COL_WIDTH
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pxFromTimestamp(ts, gridStartMs) {
  const diffMs = ts * 1000 - gridStartMs
  return (diffMs / (60 * 60 * 1000)) * HOUR_WIDTH
}

// One formatter for the whole page: toLocaleTimeString with options builds a
// new one on every call, and the grid formats thousands of times.
const timeFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })

function formatTime(ms) {
  return timeFormat.format(ms)
}

function formatTimeRange(startTime, endTime) {
  return `${timeFormat.format(startTime * 1000)} – ${timeFormat.format(endTime * 1000)}`
}

function isNow(startTime, endTime) {
  const now = Date.now() / 1000
  return startTime <= now && now < endTime
}

function clampWidth(startPx, endPx, gridWidth) {
  const clamped0 = Math.max(0, startPx)
  const clamped1 = Math.min(gridWidth, endPx)
  return Math.max(1, clamped1 - clamped0)
}

// ── Programme block ───────────────────────────────────────────────────────────
// A show that started off-screen keeps its title in view: the text is pushed
// right by however much of the block is scrolled under the channel column,
// read from the scroll container's --sl (its scrollLeft, set on scroll without
// a React render), and it re-wraps in the part that is still visible. The
// push stops MIN_TEXT_WIDTH short of the block's end so a little text remains.
//
// Text is aligned to the top so that if it ever outgrows the block (enlarged
// browser text), the time line is what gets cut, not the title.
//
// Memoized: rows re-render on every guide response, and `nowMin` (the current
// minute) is the only time input, so a block re-renders when it can change.
const ProgrammeBlock = memo(function ProgrammeBlock({ prog, channel, gridStartMs, gridWidthPx, nowMin, onSelect }) {
  const startPx = pxFromTimestamp(prog.startTime, gridStartMs)
  const endPx   = pxFromTimestamp(prog.endTime,   gridStartMs)
  const left     = Math.max(0, startPx)
  const width    = clampWidth(startPx, endPx, gridWidthPx)
  const nowSecs  = nowMin * 60
  const live     = prog.startTime <= nowSecs && nowSecs < prog.endTime
  const past     = prog.endTime <= nowSecs
  const future   = prog.startTime > nowSecs
  const range    = formatTimeRange(prog.startTime, prog.endTime)

  // Don't render blocks fully outside the visible grid range
  if (endPx <= 0 || startPx >= gridWidthPx) return null

  const showText = width >= MIN_TEXT_WIDTH
  const maxPush  = Math.max(0, width - MIN_TEXT_WIDTH - 16)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(prog, channel)}
      onKeyDown={e => e.key === 'Enter' && onSelect(prog, channel)}
      title={`${prog.title} · ${range}`}
      style={{ left, width: width - 2 }}
      className={cn(
        'absolute top-1 bottom-1 flex items-start overflow-hidden cursor-pointer select-none transition-opacity',
        'rounded-[var(--radius-sm)] border',
        showText ? 'px-2 py-1' : 'px-0',
        live  && 'bg-[var(--color-primary)]/20 border-[var(--color-primary)]/60 border-l-2 border-l-[var(--color-primary)]',
        past  && !live && 'bg-[var(--color-surface)] border-[var(--color-border)] opacity-50',
        future && !live && 'bg-[var(--color-surface-2)] border-[var(--color-border)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-surface-2)]'
      )}
    >
      {showText && (
        <div
          className="min-w-0 flex-1"
          style={{ marginLeft: `clamp(0px, calc(var(--sl, 0px) - ${left}px), ${maxPush}px)` }}
        >
          <p className={cn(
            'text-[13px] font-medium leading-snug line-clamp-2',
            live ? 'text-[var(--color-primary-light)]' : 'text-[var(--color-text)]'
          )}>
            {prog.title}
          </p>
          <p className="text-[11px] leading-snug text-[var(--color-muted)] whitespace-nowrap truncate">
            {range}
          </p>
        </div>
      )}
    </div>
  )
})

// ── Programme detail popup ────────────────────────────────────────────────────
function ProgrammePopup({ prog, channel, onClose, navigate, onToggleReminder, hasReminder }) {
  const live = isNow(prog.startTime, prog.endTime)
  const future = prog.startTime * 1000 > Date.now()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="modal-panel rounded-[var(--radius-lg)] w-full max-w-md mx-4 p-5"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h2 className="text-base font-semibold text-[var(--color-text)] break-words">{prog.title}</h2>
              {live && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-[var(--color-primary)]/20 text-[var(--color-primary-light)]">
                  LIVE
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              {channel?.name} · {formatTimeRange(prog.startTime, prog.endTime)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Description */}
        {prog.description ? (
          <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-4 max-h-32 overflow-y-auto">
            {prog.description}
          </p>
        ) : (
          <p className="text-sm text-[var(--color-muted)] italic mb-4">No description available.</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {live && channel && (
            <button
              onClick={() => {
                onClose()
                navigate(`/player?channel=${channel.uniqueId}&name=${encodeURIComponent(channel.name)}`)
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-success)] text-[#0b1a14] text-sm font-semibold hover:brightness-110 transition-[filter]"
            >
              <Play size={13} /> Watch
            </button>
          )}
          {future && (
            <button
              onClick={() => onToggleReminder(prog)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-sm font-medium border transition-colors',
                hasReminder
                  ? 'bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40 text-[var(--color-primary-light)]'
                  : 'bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-primary)]/40'
              )}
            >
              {hasReminder ? <BellOff size={13} /> : <Bell size={13} />}
              {hasReminder ? 'Remove Reminder' : 'Set Reminder'}
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-sm text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors px-2 py-1.5"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
// The Guide page's grid view: every channel against a timeline.
export default function EpgGridView({ query = '' }) {
  const navigate = useNavigate()
  const { showAdult, disabledGenres, disabledLanguages } = useApp()

  // ── Grid time window ──────────────────────────────────────────────────────
  const gridStartMs = useMemo(() => {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return now.getTime() - PAST_HOURS * 60 * 60 * 1000
  }, [])
  const gridEndMs = gridStartMs + TOTAL_HOURS * 60 * 60 * 1000
  const gridWidthPx = TOTAL_HOURS * HOUR_WIDTH

  // ── Time slots (every 30 min) ─────────────────────────────────────────────
  const timeSlots = useMemo(() => {
    const slots = []
    let t = gridStartMs
    while (t < gridEndMs) {
      slots.push(t)
      t += SLOT_MINS * 60 * 1000
    }
    return slots
  }, [gridStartMs, gridEndMs])

  // ── Channel data ──────────────────────────────────────────────────────────
  const [allChannels, setAllChannels] = useState([])
  const [logoMap, setLogoMap]     = useState({})
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [channelError, setChannelError]       = useState(null)

  useEffect(() => {
    let cancelled = false
    getCachedChannelData()
      .then(({ channels: ch, logoMap: lm }) => {
        if (cancelled) return
        setAllChannels(ch)
        setLogoMap(lm || {})
        setLoadingChannels(false)
      })
      .catch(e => { if (!cancelled) { setChannelError(e.message); setLoadingChannels(false) } })

    const unsub = subscribeChannelUpdates(({ channels: ch, logoMap: lm }) => {
      if (cancelled) return
      setAllChannels(ch)
      setLogoMap(lm || {})
    })
    return () => { cancelled = true; unsub() }
  }, [])

  // Same filters as the Channels page: adult content, and the genres and
  // languages hidden in the active profile.
  const channels = useMemo(() => {
    let ch = allChannels
    if (!showAdult) ch = ch.filter(c => !isAdult(c.genre) && !isAdult(c.name))
    if (disabledGenres.size > 0) ch = ch.filter(c => !c.genre || !disabledGenres.has(c.genre))
    if (disabledLanguages.size > 0) ch = ch.filter(c => !c.genre || !isLanguageDisabled(c.genre, disabledLanguages))
    return ch.filter(c => matchesStation(c, query))
  }, [allChannels, showAdult, disabledGenres, disabledLanguages, query])

  // ── EPG data (fetched for the rows being rendered) ───────────────────────
  const [epgMap, setEpgMap]   = useState({})      // { [uniqueId]: { events } }
  const [loadingEpg, setLoadingEpg] = useState({}) // { [uniqueId]: boolean }
  const loadedSet = useRef(new Set())

  const fetchEpgForChannel = useCallback(async (uniqueId) => {
    if (loadedSet.current.has(uniqueId)) return
    loadedSet.current.add(uniqueId)
    setLoadingEpg(m => ({ ...m, [uniqueId]: true }))
    try {
      const data = await getChannelEpg(uniqueId, 24)
      setEpgMap(m => ({ ...m, [uniqueId]: data }))
    } catch {
      setEpgMap(m => ({ ...m, [uniqueId]: { events: [] } }))
    } finally {
      setLoadingEpg(m => ({ ...m, [uniqueId]: false }))
    }
  }, [])

  // ── Reminders ─────────────────────────────────────────────────────────────
  const { reminders, addReminder: addRem, removeReminder: removeRem } = useReminders()

  const handleToggleReminder = useCallback((prog, channel) => {
    const existing = reminders.find(
      r => r.channelId === channel.uniqueId && r.startTime === prog.startTime
    )
    if (existing) {
      removeRem(existing.id)
    } else {
      addRem(channel.uniqueId, channel.name, prog.title, prog.startTime)
    }
  }, [reminders, addRem, removeRem])

  // ── Selected programme popup ──────────────────────────────────────────────
  const [selectedProg, setSelectedProg] = useState(null)
  const [selectedChannel, setSelectedChannel] = useState(null)

  const handleSelectProg = useCallback((prog, channel) => {
    setSelectedProg(prog)
    setSelectedChannel(channel)
  }, [])

  // ── Current time ──────────────────────────────────────────────────────────
  // The current minute; blocks use it for live/past styling, the red line for
  // its position. Ticks once a minute.
  const [nowMin, setNowMin] = useState(() => Math.floor(Date.now() / 60_000))
  useEffect(() => {
    const id = setInterval(() => setNowMin(Math.floor(Date.now() / 60_000)), 15_000)
    return () => clearInterval(id)
  }, [])
  const nowPx = pxFromTimestamp(nowMin * 60, gridStartMs)

  // ── Scrolling ─────────────────────────────────────────────────────────────
  // One scroll container holds the whole grid. The time header sticks to the
  // top and the channel column to the left, so a channel and its programmes
  // can never drift apart (they did as two separately scrolling panes).
  const colWidth = useChannelColWidth()
  const scrollRef = useRef(null)

  // Publishes scrollLeft as --sl for ProgrammeBlock's title offset, straight
  // to the DOM so scrolling never re-renders the grid.
  const publishScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) el.style.setProperty('--sl', `${el.scrollLeft}px`)
  }, [])

  // Start at the beginning of the current half-hour, so its time label is in
  // view — once, before the first paint, not on every minute tick.
  const scrolledToNow = useRef(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || scrolledToNow.current) return
    scrolledToNow.current = true
    el.scrollLeft = Math.max(0, Math.floor(nowPx / SLOT_WIDTH) * SLOT_WIDTH)
    publishScroll()
  }, [loadingChannels, nowPx, publishScroll])

  // Only the rows in view (plus OVERSCAN_ROWS each side) are rendered; a portal
  // can have thousands of channels. The rows start below the sticky header.
  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin: HEADER_HEIGHT,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()

  // A new search shows its matches from the top (keeping the time position).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [query])

  // Fetch the guide for the rendered rows. The overscan rows are fetched too,
  // so a row's guide is usually there before it scrolls into view.
  const firstRow = virtualRows[0]?.index ?? 0
  const lastRow  = virtualRows[virtualRows.length - 1]?.index ?? -1
  useEffect(() => {
    for (let i = firstRow; i <= lastRow; i++) {
      const ch = channels[i]
      if (ch) fetchEpgForChannel(ch.uniqueId)
    }
  }, [firstRow, lastRow, channels, fetchEpgForChannel])

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingChannels) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" />
      </div>
    )
  }

  if (channelError) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-muted)]">
        <AlertCircle size={16} /> {channelError}
      </div>
    )
  }

  const rowsHeight = rowVirtualizer.getTotalSize()
  const noMatch = channels.length === 0 && query.trim()

  return (
    <div
      ref={scrollRef}
      onScroll={publishScroll}
      className="h-full overflow-auto overscroll-contain bg-[var(--color-bg)]"
      // Keyboard focus scrolls a block into view clear of the sticky column and header.
      style={{ scrollPaddingLeft: colWidth, scrollPaddingTop: HEADER_HEIGHT }}
    >
      <div className="relative" style={{ width: colWidth + gridWidthPx }}>

        {/* ── Time header row (sticks to the top) ──────────────────────────── */}
        <div
          className="sticky top-0 z-30 flex border-b border-[var(--color-border)] bg-[var(--color-surface)]"
          style={{ height: HEADER_HEIGHT }}
        >
          {/* Corner cell — sticks to both edges */}
          <div
            className="sticky left-0 z-10 shrink-0 flex items-center px-3 border-r border-[var(--color-border)] bg-[var(--color-surface)]"
            style={{ width: colWidth }}
          >
            <span className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wider">Channels</span>
          </div>

          <div className="relative flex shrink-0" style={{ width: gridWidthPx }}>
            {timeSlots.map(slotMs => (
              <div
                key={slotMs}
                className="shrink-0 flex items-center border-r border-[var(--color-border)] px-2"
                style={{ width: SLOT_WIDTH }}
              >
                <span className="text-xs font-medium text-[var(--color-muted)] whitespace-nowrap">{formatTime(slotMs)}</span>
              </div>
            ))}
            {nowPx >= 0 && nowPx <= gridWidthPx && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none"
                style={{ left: nowPx }}
              />
            )}
          </div>
        </div>

        {noMatch && (
          <p className="sticky left-0 px-4 py-6 text-sm text-[var(--color-muted)]">No stations match “{query.trim()}”.</p>
        )}

        {/* ── Channel rows (virtualized) ───────────────────────────────────── */}
        <div className="relative" style={{ height: rowsHeight }}>
          {/* Current time line across all rows, under the sticky channel column */}
          {nowPx >= 0 && nowPx <= gridWidthPx && (
            <div
              className="absolute top-0 w-px bg-red-500/80 z-10 pointer-events-none"
              style={{ left: colWidth + nowPx, height: rowsHeight }}
            />
          )}

          {virtualRows.map(vRow => {
            const ch      = channels[vRow.index]
            const epgData = epgMap[ch.uniqueId]
            const loading = loadingEpg[ch.uniqueId] === true || !epgData
            const events  = epgData?.events || []
            const logoUrl = logoMap[String(ch.uniqueId)] || getProxiedLogoUrl(ch.iconPath)

            return (
              <div
                key={ch.uniqueId}
                className="absolute left-0 flex border-b border-[var(--color-border)]"
                style={{ top: vRow.start - HEADER_HEIGHT, height: ROW_HEIGHT, width: colWidth + gridWidthPx }}
              >
                {/* Channel cell — sticks to the left edge */}
                <div
                  className="sticky left-0 z-20 shrink-0 flex items-center gap-2.5 px-3 border-r border-[var(--color-border)] bg-[var(--color-surface)]"
                  style={{ width: colWidth }}
                  title={ch.name}
                >
                  <div className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] overflow-hidden">
                    {logoUrl
                      ? <img src={logoUrl} alt="" loading="lazy" className="h-full w-full object-contain p-0.5" onError={e => { e.target.style.display = 'none' }} />
                      : <Tv2 size={15} className="text-[var(--color-muted)]" />
                    }
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--color-text)] leading-snug line-clamp-2 break-words">{ch.name}</p>
                    {ch.number > 0 && <p className="text-[11px] text-[var(--color-muted)] leading-tight">{ch.number}</p>}
                  </div>
                </div>

                {/* Programme track */}
                <div className="relative shrink-0 bg-[var(--color-bg)]" style={{ width: gridWidthPx }}>
                  {/* Slot grid lines */}
                  {timeSlots.map(slotMs => (
                    <div
                      key={slotMs}
                      className="absolute top-0 bottom-0 border-r border-[var(--color-border)] opacity-30"
                      style={{ left: (slotMs - gridStartMs) / (60 * 60 * 1000) * HOUR_WIDTH }}
                    />
                  ))}

                  {loading ? (
                    <div className="sticky flex items-center h-full gap-2 w-[min(28rem,60vw)]" style={{ left: colWidth + 16 }}>
                      <div className="h-6 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] animate-pulse flex-1 max-w-xs" />
                      <div className="h-6 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] animate-pulse w-24" />
                    </div>
                  ) : events.length === 0 ? (
                    <div className="sticky flex items-center h-full w-fit" style={{ left: colWidth + 16 }}>
                      <span className="text-xs text-[var(--color-muted)] opacity-50">No guide data</span>
                    </div>
                  ) : (
                    events.map((prog, i) => (
                      <ProgrammeBlock
                        key={i}
                        prog={prog}
                        channel={ch}
                        gridStartMs={gridStartMs}
                        gridWidthPx={gridWidthPx}
                        nowMin={nowMin}
                        onSelect={handleSelectProg}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Programme popup ─────────────────────────────────────────────────── */}
      {selectedProg && selectedChannel && (
        <ProgrammePopup
          prog={selectedProg}
          channel={selectedChannel}
          onClose={() => { setSelectedProg(null); setSelectedChannel(null) }}
          navigate={navigate}
          hasReminder={reminders.some(
            r => r.channelId === selectedChannel.uniqueId && r.startTime === selectedProg.startTime
          )}
          onToggleReminder={(prog) => handleToggleReminder(prog, selectedChannel)}
        />
      )}
    </div>
  )
}
