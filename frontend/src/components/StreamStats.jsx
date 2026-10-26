import { useEffect, useRef, useState } from 'react'
import { Activity, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { bufferAhead, deliveryText, formatBitrate, sampleEngine } from '@/lib/streamStats'
import { getStreamDelivery, pingServer } from '../stalkerApi'

/** The player's Stats button. */
export function StatsButton({ open, onToggle, className }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn('p-1.5 rounded transition-colors', open ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10', className)}
      aria-label={open ? 'Hide stats' : 'Show stats'}
      aria-pressed={open}
      title="Stats"
    >
      <Activity size={18} />
    </button>
  )
}

/**
 * Stats for what's playing, over the video's top-left corner: the picture,
 * playback health, and the connection to the server. Kept mounted while the
 * player is, so stalls count from the start of the stream; it only samples
 * while open. `sources()` → { hls, mpegts, engine } as the player has them now.
 */
export function StreamStats({ open, onClose, videoRef, sources, kind, id, className }) {
  const [stats, setStats] = useState(null)
  const [ping, setPing] = useState(null)
  const [delivery, setDelivery] = useState(null)
  const stalls = useRef(0)
  const frames = useRef(null)   // { at, shown } — for the frame rate actually shown

  // Stalls since this channel or title started — reconnects included (they're
  // what stalls lead to), seeks not (a wait the viewer asked for).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    stalls.current = 0
    const onWaiting = () => { if (video.currentTime > 0 && !video.seeking) stalls.current++ }
    video.addEventListener('waiting', onWaiting)
    return () => video.removeEventListener('waiting', onWaiting)
  }, [videoRef, id])

  useEffect(() => {
    if (!open) return
    let live = true
    frames.current = null
    const sample = () => {
      const video = videoRef.current
      if (!video) return
      const q = video.getVideoPlaybackQuality?.()
      const now = performance.now()
      let fps = null
      if (q) {
        const shown = q.totalVideoFrames - q.droppedVideoFrames
        if (frames.current && now > frames.current.at) fps = ((shown - frames.current.shown) * 1000) / (now - frames.current.at)
        frames.current = { at: now, shown }
      }
      const src = sources() ?? {}
      setStats({
        width: video.videoWidth, height: video.videoHeight,
        fps, dropped: q?.droppedVideoFrames ?? null, total: q?.totalVideoFrames ?? null,
        buffer: bufferAhead(video.buffered, video.currentTime),
        stalls: stalls.current,
        engine: src.engine || 'browser',
        ...sampleEngine(src),
      })
    }
    // One round at a time, the next 5 s after the last answered: on a slow
    // server requests don't pile up on the player's connections, and the
    // round trip isn't time spent queueing.
    let next = null
    const network = async () => {
      const [ms, d] = await Promise.all([pingServer(), id ? getStreamDelivery(kind, id).catch(() => null) : null])
      if (!live) return
      setPing(ms)
      setDelivery(d?.delivery ?? null)
      next = setTimeout(network, 5000)
    }
    sample(); network()
    const a = setInterval(sample, 1000)
    return () => { live = false; clearInterval(a); clearTimeout(next) }
  }, [open, videoRef, sources, kind, id])

  if (!open) return null
  const s = stats
  const rows = s && [
    ['Resolution', s.width && s.height ? `${s.width}×${s.height}` : '—'],
    ['Frame rate', s.fps !== null && s.fps >= 0 ? `${Math.round(s.fps)} fps` : '—'],
    ['Video · audio', [s.video || '?', s.audio || '?'].join(' · ')],
    ['Bitrate', formatBitrate(s.bitrate)],
    ['Buffered ahead', `${s.buffer.toFixed(1)} s`],
    ['Dropped frames', s.dropped !== null ? `${s.dropped} of ${s.total}` : '—'],
    ['Stalls', String(s.stalls)],
    ['Download speed', formatBitrate(s.download)],
    ['Server round trip', ping !== null ? `${ping} ms` : '—'],
    ['Delivery', deliveryText(delivery)],
    ['Player', s.engine],
  ]
  return (
    <div
      className={cn('absolute top-3 left-3 z-30 w-72 max-w-[calc(100%-1.5rem)] rounded-[var(--radius-md)] bg-black/75 backdrop-blur-sm ring-1 ring-white/10 p-3 text-[11px] text-white/90 font-mono', className)}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Stream stats"
    >
      <div className="flex items-center justify-between mb-1.5 font-sans text-xs font-semibold text-white">
        Stats
        <button type="button" onClick={onClose} className="p-0.5 rounded text-white/70 hover:text-white" aria-label="Close stats"><X size={14} /></button>
      </div>
      {rows ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-white/55">{k}</dt>
              <dd className="text-right break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-white/60">Measuring…</p>}
    </div>
  )
}
