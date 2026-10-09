import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tv2, Loader2, AlertCircle, Play } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import { isLanguageDisabled } from '@/lib/languages'
import { matchesStation } from '@/lib/stationSearch'
import { useApp } from '@/lib/appContext'
import { getChannelEpg } from '../stalkerApi'
import { getCachedChannelData, subscribeChannelUpdates } from '@/lib/channelCache'

const PERIODS = [
  { label: '6h', value: 6 },
  { label: '12h', value: 12 },
  { label: '24h', value: 24 },
  { label: '48h', value: 48 },
]

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function isNow(startTime, endTime) {
  const now = Date.now() / 1000
  return startTime <= now && now < endTime
}

// The Guide page's list view: one channel's programmes at a time.
export default function GuideListView({ query = '' }) {
  const navigate = useNavigate()
  const { showAdult, disabledGenres, disabledLanguages } = useApp()
  const [allChannels, setChannels] = useState([])
  const [activeChannel, setActiveChannel] = useState(null)
  const [epg, setEpg] = useState([])
  const [period, setPeriod] = useState(24)
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [loadingEpg, setLoadingEpg] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const hasInit = { current: false }

    // Same filters as the grid and the Channels page: adult content, and the
    // genres and languages hidden in the active profile.
    function filterChannels(ch) {
      let out = ch
      if (!showAdult) out = out.filter(c => !isAdult(c.genre) && !isAdult(c.name))
      if (disabledGenres.size > 0) out = out.filter(c => !c.genre || !disabledGenres.has(c.genre))
      if (disabledLanguages.size > 0) out = out.filter(c => !c.genre || !isLanguageDisabled(c.genre, disabledLanguages))
      return out
    }

    getCachedChannelData()
      .then(({ channels: ch }) => {
        if (cancelled) return
        const filtered = filterChannels(ch)
        setChannels(filtered)
        if (filtered.length && !hasInit.current) { hasInit.current = true; setActiveChannel(filtered[0]) }
        setLoadingChannels(false)
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoadingChannels(false) } })

    // Subscribe so the sidebar populates automatically when loading completes
    const unsub = subscribeChannelUpdates(({ channels: ch }) => {
      if (cancelled) return
      const filtered = filterChannels(ch)
      setChannels(filtered)
      if (filtered.length && !hasInit.current) { hasInit.current = true; setActiveChannel(filtered[0]) }
      setLoadingChannels(false)
    })

    return () => { cancelled = true; unsub() }
  }, [showAdult, disabledGenres, disabledLanguages])

  const channels = useMemo(() => allChannels.filter(ch => matchesStation(ch, query)), [allChannels, query])

  // Searching shows the first match.
  useEffect(() => {
    if (!query.trim() || !channels.length) return
    setActiveChannel(cur => (cur && channels.some(c => c.uniqueId === cur.uniqueId) ? cur : channels[0]))
  }, [query, channels])

  useEffect(() => {
    if (!activeChannel?.uniqueId) return
    let cancelled = false
    setLoadingEpg(true)
    setEpg([])
    getChannelEpg(activeChannel.uniqueId, period)
      .then(data => { if (!cancelled) setEpg(data?.events || []) })
      .catch(() => { if (!cancelled) setEpg([]) })
      .finally(() => { if (!cancelled) setLoadingEpg(false) })
    return () => { cancelled = true }
  }, [activeChannel?.uniqueId, period])

  return (
    <div className="flex h-full">
      {/* Channel sidebar */}
      <div className="w-52 shrink-0 border-r border-[var(--color-border)] flex flex-col bg-[var(--color-surface)]">
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">Channels</p>
        </div>
        {loadingChannels ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin text-[var(--color-primary-light)]" />
          </div>
        ) : (
          <ScrollArea className="flex-1">
            {channels.length === 0 && (
              <p className="px-4 py-3 text-xs text-[var(--color-muted)]">No stations match “{query.trim()}”.</p>
            )}
            {channels.map(ch => (
              <button
                key={ch.id}
                onClick={() => setActiveChannel(ch)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors',
                  ch.uniqueId === activeChannel?.uniqueId
                    ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary-light)]'
                    : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
                )}
              >
                <Tv2 size={13} className="shrink-0" />
                <span className="text-xs truncate">{ch.name}</span>
              </button>
            ))}
          </ScrollArea>
        )}
      </div>

      {/* EPG panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-4 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
          <h2 className="font-semibold text-sm text-[var(--color-text)] truncate flex-1">
            {activeChannel?.name || 'Select a channel'}
          </h2>
          <div className="flex items-center gap-1">
            {PERIODS.map(p => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={cn(
                  'px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors',
                  period === p.value
                    ? 'bg-[var(--color-primary)] text-[var(--color-bg)]'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {activeChannel && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/player?channel=${activeChannel.uniqueId}&name=${encodeURIComponent(activeChannel.name)}`)}
            >
              <Play size={13} /> Watch
            </Button>
          )}
        </div>

        {/* Programme list */}
        <ScrollArea className="flex-1 px-6 py-4">
          {loadingEpg && (
            <div className="flex items-center justify-center h-32">
              <Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" />
            </div>
          )}

          {!loadingEpg && error && (
            <div className="flex items-center gap-2 text-sm text-[var(--color-live)] mt-4">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {!loadingEpg && !error && epg.length === 0 && (
            <p className="text-sm text-[var(--color-muted)] mt-4">No EPG data available for this channel.</p>
          )}

          {!loadingEpg && epg.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {epg.map((prog, i) => {
                const live = isNow(prog.startTime, prog.endTime)
                return (
                  <div
                    key={i}
                    className={cn(
                      'flex gap-4 rounded-[var(--radius-sm)] px-4 py-3 transition-colors',
                      live
                        ? 'bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/30'
                        : 'bg-[var(--color-surface)] border border-transparent hover:border-[var(--color-border)]'
                    )}
                  >
                    <div className="shrink-0 w-24 text-xs text-[var(--color-muted)] pt-0.5">
                      {formatTime(prog.startTime)}
                      {prog.endTime && <span className="block">{formatTime(prog.endTime)}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={cn('text-sm font-medium truncate', live ? 'text-[var(--color-primary-light)]' : 'text-[var(--color-text)]')}>
                          {prog.title || 'Untitled'}
                        </p>
                        {live && <Badge variant="live" className="shrink-0">NOW</Badge>}
                      </div>
                      {prog.description && (
                        <p className="text-xs text-[var(--color-muted)] mt-0.5 line-clamp-2">{prog.description}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}
