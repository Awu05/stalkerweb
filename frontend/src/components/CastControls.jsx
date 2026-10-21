import { useState } from 'react'
import { formatTime } from '@/lib/formatTime'
import { Airplay, Cast, Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

/** The player's Cast (Chromecast) and AirPlay buttons — each only where the browser can, and a TV is around. */
export function CastButtons({ cast, className }) {
  const btn = 'p-1.5 rounded transition-colors'
  return (
    <>
      {cast.chromecast.available && (
        <button
          type="button"
          onClick={cast.mode === 'chromecast' ? cast.chromecast.stop : cast.chromecast.start}
          className={cn(btn, cast.mode === 'chromecast' ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10', className)}
          aria-label={cast.mode === 'chromecast' ? `Stop casting to ${cast.device || 'the TV'}` : 'Cast to a TV'}
          aria-pressed={cast.mode === 'chromecast'}
          title={cast.mode === 'chromecast' ? `Casting to ${cast.device || 'TV'} — click to stop` : 'Cast'}
        >
          <Cast size={18} />
        </button>
      )}
      {cast.airplay.available && (
        <button
          type="button"
          onClick={cast.airplay.start}
          className={cn(btn, cast.mode === 'airplay' ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10', className)}
          aria-label="AirPlay"
          aria-pressed={cast.mode === 'airplay'}
          title="AirPlay"
        >
          <Airplay size={18} />
        </button>
      )}
    </>
  )
}

/**
 * Over the video while it plays on a TV: where, and — for a movie on a
 * Chromecast — its controls (AirPlay is driven by the page's own). A tap on it
 * is onActivity (the page shows its controls), not the page's play/pause.
 */
export function CastingOverlay({ cast, live, onActivity }) {
  const [drag, setDrag] = useState(null)
  if (!cast.mode) return null
  const { playing, time, duration } = cast.remote
  const controls = cast.mode === 'chromecast' && !live
  return (
    // Its clicks are its own: under it, a click would play/pause the page's video.
    <div
      onClick={(e) => { e.stopPropagation(); onActivity?.() }}
      className={cn('absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 px-6 text-white', cast.mode === 'chromecast' ? 'bg-black' : 'bg-black/60 pointer-events-none')}
    >
      {cast.mode === 'airplay' ? <Airplay size={40} /> : <Cast size={40} />}
      <p className="text-sm font-medium">Playing on {cast.device || 'TV'}</p>
      {controls && (
        <>
          {duration > 0 && (
            <div className="w-full max-w-lg flex flex-col gap-1">
              <Slider
                min={0} max={duration} step={1}
                value={[drag ?? time]}
                onValueChange={([v]) => setDrag(v)}
                onValueCommit={([v]) => { cast.seekTo(v); setDrag(null) }}
                aria-label="Seek on the TV"
              />
              <span className="text-xs text-white/60 text-center tabular-nums">{formatTime(drag ?? time)} / {formatTime(duration)}</span>
            </div>
          )}
          <div className="flex items-center gap-6">
            <button type="button" onClick={() => cast.seekTo(time - 10)} aria-label="Back 10 seconds" className="p-2 text-white/80 hover:text-white"><RotateCcw size={22} /></button>
            <button type="button" onClick={cast.togglePlay} aria-label={playing ? 'Pause' : 'Play'} className="p-3 rounded-full bg-white/10 hover:bg-white/20">
              {playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
            </button>
            <button type="button" onClick={() => cast.seekTo(time + 30)} aria-label="Forward 30 seconds" className="p-2 text-white/80 hover:text-white"><RotateCw size={22} /></button>
          </div>
        </>
      )}
      {cast.mode === 'chromecast' && (
        <button type="button" onClick={cast.chromecast.stop} className="text-xs text-white/60 hover:text-white underline">Stop casting</button>
      )}
    </div>
  )
}
