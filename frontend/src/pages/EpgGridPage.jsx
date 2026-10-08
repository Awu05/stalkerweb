import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, X, Bell, BellOff, Tv2, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import { useApp } from '@/lib/appContext'
import { getCachedChannelData, subscribeChannelUpdates } from '@/lib/channelCache'
import { getChannelEpg, getProxiedLogoUrl } from '../stalkerApi'
import { useReminders } from '@/lib/useReminders'

// ── Constants ─────────────────────────────────────────────────────────────────
const CHANNEL_COL_WIDTH = 220   // px — sticky left column
const CHANNEL_COL_WIDTH_SM = 132 // px — on phones
const HOUR_WIDTH = 280          // px — 1 hour = 280px → 30min = 140px
const SLOT_MINS = 30            // time column slot width in minutes
const PAST_HOURS = 2            // hours before now to show
const FUTURE_HOURS = 12         // hours after now to show
const TOTAL_HOURS = PAST_HOURS + FUTURE_HOURS  // 14h window
const BATCH_SIZE = 50           // first N channels to eagerly load EPG for
const ROW_HEIGHT = 64           // px
const HEADER_HEIGHT = 36        // px
const MIN_TEXT_WIDTH = 28       // px — narrower blocks show no text, only a tooltip

const SMALL_SCREEN = '(max-width: 639px)'
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

function formatTime(ms) {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatTimeRange(startTime, endTime) {
  const fmt = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${fmt(startTime)} – ${fmt(endTime)}`
}

function isNow(startTime, endTime) {
  const now = Date.now() / 1000
  return startTime <= now && now < endTime
}

function isPast(endTime) {
  return endTime * 1000 < Date.now()
}

function clampWidth(startPx, endPx, gridWidth) {
  const clamped0 = Math.max(0, startPx)
  const clamped1 = Math.min(gridWidth, endPx)
  return Math.max(1, clamped1 - clamped0)
}

// ── Programme block ───────────────────────────────────────────────────────────
// The title sticks to the channel column's edge while the block scrolls under
// it, so a show that started off-screen still says what it is. That needs the
// block to clip with overflow:clip — overflow:hidden would make the block the
// sticky title's scroll container and pin it in place.
function ProgrammeBlock({ prog, gridStartMs, gridWidthPx, stickyLeft, onSelect }) {
  const startPx = pxFromTimestamp(prog.startTime, gridStartMs)
  const endPx   = pxFromTimestamp(prog.endTime,   gridStartMs)
  const left     = Math.max(0, startPx)
  const width    = clampWidth(startPx, endPx, gridWidthPx)
  const live     = isNow(prog.startTime, prog.endTime)
  const past     = isPast(prog.endTime)
  const future   = prog.startTime * 1000 > Date.now()

  // Don't render blocks fully outside the visible grid range
  if (endPx <= 0 || startPx >= gridWidthPx) return null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(prog)}
      onKeyDown={e => e.key === 'Enter' && onSelect(prog)}
      title={`${prog.title} · ${formatTimeRange(prog.startTime, prog.endTime)}`}
      style={{ left, width: width - 2 }}
      className={cn(
        'absolute top-1 bottom-1 flex items-center overflow-clip cursor-pointer select-none transition-opacity',
        'rounded-[var(--radius-sm)] border',
        width >= MIN_TEXT_WIDTH ? 'px-2' : 'px-0',
        live  && 'bg-[var(--color-primary)]/20 border-[var(--color-primary)]/60 border-l-2 border-l-[var(--color-primary)]',
        past  && !live && 'bg-[var(--color-surface)] border-[var(--color-border)] opacity-50',
        future && !live && 'bg-[var(--color-surface-2)] border-[var(--color-border)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-surface-2)]'
      )}
    >
      {width >= MIN_TEXT_WIDTH && (
        <div className="sticky min-w-0 max-w-full" style={{ left: stickyLeft }}>
          <p className={cn(
            'text-[13px] font-medium leading-snug line-clamp-2',
            live ? 'text-[var(--color-primary-light)]' : 'text-[var(--color-text)]'
          )}>
            {prog.title}
          </p>
          <p className="text-[11px] text-[var(--color-muted)] whitespace-nowrap truncate">
            {formatTimeRange(prog.startTime, prog.endTime)}
          </p>
        </div>
      )}
    </div>
  )
}

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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
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
export default function EpgGridPage() {
  const navigate = useNavigate()
  const { showAdult } = useApp()

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
  const [channels, setChannels]   = useState([])
  const [logoMap, setLogoMap]     = useState({})
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [channelError, setChannelError]       = useState(null)

  useEffect(() => {
    let cancelled = false
    getCachedChannelData()
      .then(({ channels: ch, logoMap: lm }) => {
        if (cancelled) return
        const filtered = showAdult ? ch : ch.filter(c => !isAdult(c.genre) && !isAdult(c.name))
        setChannels(filtered)
        setLogoMap(lm || {})
        setLoadingChannels(false)
      })
      .catch(e => { if (!cancelled) { setChannelError(e.message); setLoadingChannels(false) } })

    const unsub = subscribeChannelUpdates(({ channels: ch, logoMap: lm }) => {
      if (cancelled) return
      const filtered = showAdult ? ch : ch.filter(c => !isAdult(c.genre) && !isAdult(c.name))
      setChannels(filtered)
      setLogoMap(lm || {})
    })
    return () => { cancelled = true; unsub() }
  }, [showAdult])

  // ── EPG data (lazy load by visibility) ───────────────────────────────────
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

  // Eagerly load first BATCH_SIZE channels on mount
  useEffect(() => {
    if (!channels.length) return
    const batch = channels.slice(0, BATCH_SIZE)
    batch.forEach(ch => fetchEpgForChannel(ch.uniqueId))
  }, [channels, fetchEpgForChannel])

  // IntersectionObserver for rows beyond the first batch
  const rowObserver = useRef(null)
  useEffect(() => {
    rowObserver.current?.disconnect()
    rowObserver.current = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const uid = entry.target.dataset.channelId
            if (uid) fetchEpgForChannel(uid)
          }
        })
      },
      { threshold: 0, rootMargin: '200px 0px' }
    )
    return () => rowObserver.current?.disconnect()
  }, [fetchEpgForChannel])

  const registerRow = useCallback((el, index) => {
    if (!el || index < BATCH_SIZE) return
    rowObserver.current?.observe(el)
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

  // ── Current time indicator ────────────────────────────────────────────────
  const [nowPx, setNowPx] = useState(() => pxFromTimestamp(Date.now() / 1000, gridStartMs))
  useEffect(() => {
    const id = setInterval(() => {
      setNowPx(pxFromTimestamp(Date.now() / 1000, gridStartMs))
    }, 60_000)
    return () => clearInterval(id)
  }, [gridStartMs])

  // ── Scrolling ─────────────────────────────────────────────────────────────
  // One scroll container holds the whole grid. The time header sticks to the
  // top and the channel column to the left, so a channel and its programmes
  // can never drift apart (they did as two separately scrolling panes).
  const colWidth = useChannelColWidth()
  const scrollRef = useRef(null)

  // Start scrolled to just before "now" — once, not on every minute tick.
  const scrolledToNow = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || scrolledToNow.current) return
    scrolledToNow.current = true
    el.scrollLeft = Math.max(0, nowPx - 80)
  }, [loadingChannels, nowPx])

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingChannels) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] lg:h-dvh items-center justify-center">
        <Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" />
      </div>
    )
  }

  if (channelError) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] lg:h-dvh items-center justify-center gap-2 text-sm text-[var(--color-muted)]">
        <AlertCircle size={16} /> {channelError}
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="h-[calc(100dvh-3.5rem)] lg:h-dvh overflow-auto overscroll-contain bg-[var(--color-bg)]"
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
                style={{ width: SLOT_MINS * (HOUR_WIDTH / 60) }}
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

        {/* Current time line across all rows, under the sticky channel column */}
        {nowPx >= 0 && nowPx <= gridWidthPx && (
          <div
            className="absolute w-px bg-red-500/80 z-10 pointer-events-none"
            style={{ left: colWidth + nowPx, top: HEADER_HEIGHT, height: channels.length * ROW_HEIGHT }}
          />
        )}

        {/* ── Channel rows ─────────────────────────────────────────────────── */}
        {channels.map((ch, idx) => {
          const epgData = epgMap[ch.uniqueId]
          const loading = loadingEpg[ch.uniqueId] === true
          const events  = epgData?.events || []
          const logoUrl = logoMap[String(ch.uniqueId)] || getProxiedLogoUrl(ch.iconPath)

          return (
            <div key={ch.uniqueId} className="flex border-b border-[var(--color-border)]" style={{ height: ROW_HEIGHT }}>
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
              <div
                data-channel-id={ch.uniqueId}
                ref={el => registerRow(el, idx)}
                className="relative shrink-0 bg-[var(--color-bg)]"
                style={{ width: gridWidthPx }}
              >
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
                ) : events.length === 0 && epgData ? (
                  <div className="sticky flex items-center h-full w-fit" style={{ left: colWidth + 16 }}>
                    <span className="text-xs text-[var(--color-muted)] opacity-50">No guide data</span>
                  </div>
                ) : (
                  events.map((prog, i) => (
                    <ProgrammeBlock
                      key={i}
                      prog={prog}
                      gridStartMs={gridStartMs}
                      gridWidthPx={gridWidthPx}
                      stickyLeft={colWidth + 8}
                      onSelect={p => handleSelectProg(p, ch)}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
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
