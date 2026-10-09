import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import Hls from 'hls.js'
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  ChevronLeft, AlertCircle, Loader2, Clock, Calendar, X, PictureInPicture2,
  SkipBack, SkipForward, ListVideo,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { getVodStreamUrl, getVodSeasons, getVodEpisodes } from '../stalkerApi'
import EpisodePanel from '@/components/EpisodePanel'
import MyListButton from '@/components/MyListButton'
import { episodeNeighbours } from '@/lib/episodeNav'
import {
  makeVodKey, getVodProgress, saveVodProgress,
  VOD_RESUME_MIN_SECS, VOD_DONE_FRACTION,
} from '@/lib/vodProgress'

function formatTime(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export default function VodPlayerPage() {
  const [searchParams] = useSearchParams()
  const navigate        = useNavigate()
  const location        = useLocation()
  // Back to where the player was opened from; opened directly, to VOD.
  const openedDirectly = location.key === 'default' || location.state?.direct === true
  const goBack = () => (openedDirectly ? navigate('/vod') : navigate(-1))

  const videoId      = searchParams.get('videoId') || ''
  const cmd          = searchParams.get('cmd') || ''
  const title        = searchParams.get('title') || 'Untitled'
  const seriesNo     = parseInt(searchParams.get('series') || '0', 10)
  const seasonId     = searchParams.get('seasonId') || ''
  const episodeId    = searchParams.get('episodeId') || ''
  const episodeTitle = searchParams.get('episodeTitle') || ''

  const displayTitle = episodeTitle ? `${title} · ${episodeTitle}` : title

  // This movie or show as a My List title, from the player link.
  const decoded = (k) => { const v = searchParams.get(k); try { return v ? decodeURIComponent(v) : '' } catch { return v || '' } }
  const myListItem = {
    id: videoId, name: title, cmd, isSeries: !!(seasonId || episodeId),
    year: searchParams.get('year') || '', isHD: searchParams.get('isHD') === 'true',
    durationMin: parseInt(searchParams.get('durationMin') || '0', 10) || 0,
    screenshotUrl: decoded('screenshotUrl'), description: decoded('description'), director: decoded('director'), actors: decoded('actors'),
  }

  const videoRef     = useRef(null)
  const hlsRef       = useRef(null)
  const containerRef = useRef(null)
  const hideTimer    = useRef(null)
  const volumeRef    = useRef(80)
  const mutedRef     = useRef(false)

  const [status, setStatus]           = useState('loading') // loading | playing | paused | error
  const [errorMsg, setErrorMsg]       = useState('')
  const [playing, setPlaying]         = useState(false)
  const [muted, setMuted]             = useState(false)
  const [volume, setVolume]           = useState(80)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration]       = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPiP, setIsPiP]               = useState(false)
  const [resumedFrom, setResumedFrom] = useState(0) // >0 → show "resumed" banner

  // ── A show's episodes: the list, next / previous, auto-play next ──────────
  const isEpisode = !!(seasonId || episodeId)
  const [seasons, setSeasons]           = useState(null)   // in order; null while loading
  const [episodesBySeason, setEpisodes] = useState({})     // seasonId → episodes, in order
  const [panelSeason, setPanelSeason]   = useState(seasonId)
  const [episodesOpen, setEpisodesOpen] = useState(false)  // the pop-up list on narrow screens
  const [upNext, setUpNext]             = useState(null)   // { season, episode } after the end
  const loadingSeasons = useRef(new Set())

  useEffect(() => {
    setSeasons(null); setEpisodes({}); loadingSeasons.current = new Set()
    if (!isEpisode || !videoId) return
    let cancelled = false
    getVodSeasons(videoId).then((r) => { if (!cancelled) setSeasons(r.seasons || []) }).catch(() => { if (!cancelled) setSeasons([]) })
    return () => { cancelled = true }
  }, [videoId, isEpisode])

  const loadSeason = useCallback((id) => {
    if (!id || loadingSeasons.current.has(id)) return
    loadingSeasons.current.add(id)
    getVodEpisodes(videoId, id)
      .then((r) => setEpisodes((m) => ({ ...m, [id]: r.episodes || [] })))
      .catch(() => { loadingSeasons.current.delete(id) })
  }, [videoId])

  useEffect(() => { setPanelSeason(seasonId) }, [seasonId])
  useEffect(() => { if (seasons) { loadSeason(seasonId); loadSeason(panelSeason) } }, [seasons, seasonId, panelSeason, loadSeason])

  const neighbours = seasons ? episodeNeighbours(seasons, episodesBySeason, seasonId, episodeId) : { prev: null, next: null, needs: [] }
  // The show's very last episode: finishing it moves the show to Completed on My List.
  const lastEpisode = isEpisode && !!seasons && !!episodesBySeason[seasonId] && !neighbours.next && neighbours.needs.length === 0
  useEffect(() => { metaRef.current = { ...metaRef.current, lastEpisode } })
  const needsKey = neighbours.needs.join(',')
  useEffect(() => { needsKey.split(',').filter(Boolean).forEach(loadSeason) }, [needsKey, loadSeason])

  // Another episode of the same show: the player link with that episode, in
  // place of this one in the history, so Back still leaves the show.
  function playEpisode(season, ep) {
    if (!season || !ep) return
    const next = new URLSearchParams(searchParams)
    next.set('series', String(ep.seriesNumber || '0'))
    next.set('seasonId', String(season.id))
    next.set('episodeId', String(ep.episodeId))
    next.set('episodeTitle', ep.name || `Episode ${ep.seriesNumber}`)
    setUpNext(null)
    setEpisodesOpen(false)
    navigate(`/vod-player?${next}`, { replace: true, state: { direct: openedDirectly } })
  }
  const playEpisodeRef = useRef(playEpisode)
  useEffect(() => { playEpisodeRef.current = playEpisode })
  const nextRef = useRef(null)
  useEffect(() => { nextRef.current = neighbours.next })
  const prevRef = useRef(null)
  useEffect(() => { prevRef.current = neighbours.prev })
  useEffect(() => { setUpNext(null) }, [seasonId, episodeId])

  // N / P: next and previous episode, from a keyboard or TV remote.
  useEffect(() => {
    if (!isEpisode) return
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return
      const n = e.code === 'KeyN' ? nextRef.current : e.code === 'KeyP' ? prevRef.current : null
      if (!n) return
      e.preventDefault()
      playEpisodeRef.current(n.season, n.episode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isEpisode])

  useEffect(() => { volumeRef.current = volume }, [volume])
  useEffect(() => { mutedRef.current  = muted  }, [muted])

  // ── Continue Watching: persist position + resume ──────────────────────────
  const progressKey = makeVodKey({ videoId, seasonId, episodeId })

  // Latest metadata for the saver, read through a ref so the save interval
  // doesn't need to re-bind when params change (router reuses this component).
  const metaRef = useRef({})
  useEffect(() => {
    metaRef.current = {
      key:           progressKey,
      // The movie or show, and the episode — Recently watched lists a show once.
      title:         title,
      episodeTitle:  episodeTitle,
      screenshotUrl: searchParams.get('screenshotUrl') ? decodeURIComponent(searchParams.get('screenshotUrl')) : '',
      params:        searchParams.toString(),
    }
  }, [progressKey, title, episodeTitle, searchParams])

  // Write current position to the store (auto-prunes when finished/barely-started).
  const persist = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.duration || !isFinite(v.duration)) return
    saveVodProgress({ ...metaRef.current, position: v.currentTime, duration: v.duration })
  }, [])

  // Save every 10s while playing, and once more on unmount / title change.
  useEffect(() => {
    const id = setInterval(() => { if (!videoRef.current?.paused) persist() }, 10_000)
    return () => { clearInterval(id); persist() }
  }, [persist, progressKey])

  // Resume once per title, after the duration is known. Re-runs if the user
  // navigates to a different title without the component remounting.
  const resumedKeyRef = useRef(null)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !duration || resumedKeyRef.current === progressKey) return
    resumedKeyRef.current = progressKey
    const saved = getVodProgress(progressKey)
    if (saved && saved.position >= VOD_RESUME_MIN_SECS && saved.position < duration * VOD_DONE_FRACTION) {
      try { v.currentTime = saved.position } catch { /* seek rejected */ }
      setResumedFrom(saved.position)
    } else {
      setResumedFrom(0)
    }
  }, [progressKey, duration])

  // Auto-hide the "resumed" banner after a few seconds.
  useEffect(() => {
    if (!resumedFrom) return
    const t = setTimeout(() => setResumedFrom(0), 8000)
    return () => clearTimeout(t)
  }, [resumedFrom])

  // Also capture the position the moment playback pauses.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPause = () => persist()
    v.addEventListener('pause', onPause)
    return () => v.removeEventListener('pause', onPause)
  }, [persist])

  // Fetch + load stream
  useEffect(() => {
    if (!videoId) { setStatus('error'); setErrorMsg('No video ID provided.'); return }

    let cancelled = false
    setStatus('loading')
    setErrorMsg('')

    getVodStreamUrl({ videoId, cmd, series: seriesNo, seasonId, episodeId })
      .then(({ streamUrl }) => {
        if (!cancelled) loadStreamUrl(streamUrl)
      })
      .catch(e => {
        if (!cancelled) { setStatus('error'); setErrorMsg(e.message) }
      })

    return () => { cancelled = true }
  }, [videoId, cmd, seriesNo, seasonId, episodeId])

  function loadStreamUrl(url) {
    const video = videoRef.current
    if (!video) return

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }

    const tryPlay = () =>
      video.play()
        .then(() => { setStatus('playing'); setPlaying(true) })
        .catch(() => {
          video.muted = true; setMuted(true)
          return video.play()
            .then(() => { setStatus('playing'); setPlaying(true) })
            .catch(() => { setStatus('paused'); setPlaying(false) })
        })

    const playNative = (src) => {
      video.src = src
      video.volume = volumeRef.current / 100
      video.muted  = mutedRef.current
      tryPlay()
    }

    const isNative = /\.(mp4|mkv|avi|mov|webm|ts|mpg|mpeg|mp2|m4v)(\?|$)/i.test(url)
    if (isNative) { playNative(url); return }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false })
      hlsRef.current = hls
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.volume = volumeRef.current / 100
        video.muted  = mutedRef.current
        tryPlay()
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError()
          } else {
            hls.destroy(); hlsRef.current = null
            playNative(url)
          }
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      playNative(url)
    } else {
      setStatus('error'); setErrorMsg('HLS is not supported in this browser.')
    }
  }

  // Sync volume/mute to video element
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume / 100
    v.muted  = muted
  }, [volume, muted])

  // Video event listeners
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime   = () => setCurrentTime(v.currentTime)
    const onDur    = () => setDuration(v.duration || 0)
    const onPlay   = () => { setPlaying(true); setStatus('playing') }
    const onPause  = () => { setPlaying(false); setStatus('paused') }
    const onEnded  = () => { setPlaying(false); setStatus('paused'); if (nextRef.current) setUpNext(nextRef.current) }
    v.addEventListener('timeupdate',       onTime)
    v.addEventListener('durationchange',   onDur)
    v.addEventListener('play',             onPlay)
    v.addEventListener('pause',            onPause)
    v.addEventListener('ended',            onEnded)
    return () => {
      v.removeEventListener('timeupdate',     onTime)
      v.removeEventListener('durationchange', onDur)
      v.removeEventListener('play',           onPlay)
      v.removeEventListener('pause',          onPause)
      v.removeEventListener('ended',          onEnded)
    }
  }, [])

  // Cleanup HLS on unmount
  useEffect(() => () => { hlsRef.current?.destroy() }, [])

  // Auto-hide controls when playing fullscreen
  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimer.current)
    if (playing && isFullscreen) {
      hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    }
  }, [playing, isFullscreen])

  useEffect(() => { resetHideTimer(); return () => clearTimeout(hideTimer.current) }, [resetHideTimer])

  // Fullscreen sync
  useEffect(() => {
    const h = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
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

  function togglePlayPause() {
    const v = videoRef.current; if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen()
    else document.exitFullscreen()
  }

  async function togglePiP() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await videoRef.current?.requestPictureInPicture()
    } catch { /* PiP not supported or denied */ }
  }

  function seek(pct) {
    const v = videoRef.current; if (!v || !duration) return
    v.currentTime = (pct / 100) * duration
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-3.5rem)] bg-black">

      {/* ── Video panel ── */}
      <div
        ref={containerRef}
        className="relative flex-1 flex flex-col bg-black"
        onMouseMove={resetHideTimer}
        onMouseLeave={() => clearTimeout(hideTimer.current)}
      >
        {/* Back button (always visible, top-left) */}
        <div className={cn(
          'absolute top-0 inset-x-0 z-20 flex items-center gap-2 px-3 py-2 bg-gradient-to-b from-black/60 to-transparent transition-opacity duration-300',
          showControls || status !== 'playing' ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}>
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 text-white/80 hover:text-white transition-colors text-sm"
          >
            <ChevronLeft size={18} />
            Back
          </button>
          <span className="flex-1 text-center text-sm font-medium text-white/90 truncate px-4">
            {displayTitle}
          </span>
        </div>

        {/* Resumed-from banner */}
        {resumedFrom > 0 && status !== 'loading' && status !== 'error' && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-1.5 rounded-full bg-black/75 backdrop-blur-sm text-white text-xs shadow-lg">
            <span>Resumed from {formatTime(resumedFrom)}</span>
            <button
              onClick={() => { const v = videoRef.current; if (v) v.currentTime = 0; setResumedFrom(0) }}
              className="text-[var(--color-primary-light)] hover:underline font-medium"
            >
              Start over
            </button>
            <button onClick={() => setResumedFrom(0)} aria-label="Dismiss" className="text-white/60 hover:text-white">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Video element */}
        {/* The video is pinned to this area's edges: sized from its own width
            instead, a 16:9 picture on an ultrawide screen in fullscreen came out
            taller than the screen and lost its top and bottom. */}
        <div
          className="relative flex-1 min-h-0 cursor-pointer"
          onClick={togglePlayPause}
        >
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline />
        </div>

        {/* Loading overlay */}
        {status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 pointer-events-none">
            <Loader2 size={40} className="animate-spin text-[var(--color-primary-light)]" />
            <p className="text-sm text-white/60">Loading stream…</p>
          </div>
        )}

        {/* Error overlay */}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
            <AlertCircle size={40} className="text-[var(--color-live)]" />
            <p className="text-sm text-white/80 max-w-xs text-center">{errorMsg}</p>
            <button
              onClick={goBack}
              className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
            >
              Go back
            </button>
          </div>
        )}

        {/* Paused icon */}
        {status === 'paused' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="rounded-full bg-black/40 backdrop-blur-sm ring-1 ring-white/15 p-6 shadow-[0_0_48px_-8px_var(--color-primary-glow)]">
              <Play size={40} className="text-white" fill="currentColor" />
            </div>
          </div>
        )}

        {upNext && (
          <UpNextCard next={upNext} onPlay={() => playEpisode(upNext.season, upNext.episode)} onCancel={() => setUpNext(null)} />
        )}

        {episodesOpen && (
          <div className="lg:hidden absolute inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60" onClick={() => setEpisodesOpen(false)}>
            <div className="w-full sm:max-w-md max-h-[75%] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-[var(--color-surface)] p-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center mb-2">
                <p className="text-sm font-semibold text-[var(--color-text)] truncate">{title}</p>
                <button onClick={() => setEpisodesOpen(false)} className="ml-auto p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]" aria-label="Close"><X size={16} /></button>
              </div>
              <EpisodePanel seasons={seasons} seasonId={panelSeason} onSeason={setPanelSeason} episodes={episodesBySeason[panelSeason]}
                playingSeasonId={seasonId} playingEpisodeId={episodeId} onPlay={playEpisode} />
            </div>
          </div>
        )}

        {/* Controls bar */}
        <div className={cn(
          'absolute bottom-0 inset-x-0 z-20 transition-opacity duration-300',
          showControls || status !== 'playing' ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}>
          {/* Seek bar */}
          {duration > 0 && (
            <div className="px-4 pb-1" onClick={e => e.stopPropagation()}>
              <Slider
                min={0} max={100} step={0.1}
                value={[progressPct]}
                onValueChange={([v]) => seek(v)}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-white/50 mt-0.5">
                <span>{formatTime(currentTime)}</span>
                <span>-{formatTime(duration - currentTime)}</span>
              </div>
            </div>
          )}

          {/* Playback controls */}
          <div
            className="flex items-center gap-3 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent"
            onClick={e => e.stopPropagation()}
          >
            {isEpisode && (
              <button onClick={() => playEpisode(neighbours.prev?.season, neighbours.prev?.episode)} disabled={!neighbours.prev}
                className="text-white/80 hover:text-white p-1 transition-colors disabled:opacity-30" aria-label="Previous episode" title="Previous episode (P)">
                <SkipBack size={18} fill="currentColor" />
              </button>
            )}
            <button onClick={togglePlayPause} className="text-white/90 hover:text-white p-1 transition-colors">
              {playing
                ? <Pause size={20} fill="currentColor" />
                : <Play  size={20} fill="currentColor" />}
            </button>
            {isEpisode && (
              <button onClick={() => playEpisode(neighbours.next?.season, neighbours.next?.episode)} disabled={!neighbours.next}
                className="text-white/80 hover:text-white p-1 transition-colors disabled:opacity-30" aria-label="Next episode" title="Next episode (N)">
                <SkipForward size={18} fill="currentColor" />
              </button>
            )}
            <div className="flex items-center gap-2 group/vol">
              <button onClick={() => setMuted(m => !m)} className="text-white/90 hover:text-white p-1 transition-colors">
                {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <div className="w-0 overflow-hidden group-hover/vol:w-20 transition-all duration-200">
                <Slider min={0} max={100} step={1} value={[muted ? 0 : volume]}
                  onValueChange={([v]) => { setVolume(v); setMuted(false) }} className="w-20" />
              </div>
            </div>
            <div className="flex-1" />
            {isEpisode && (
              <button onClick={() => setEpisodesOpen(true)} className="lg:hidden text-white/80 hover:text-white p-1.5 rounded hover:bg-white/10 transition-colors" aria-label="Episodes" title="Episodes">
                <ListVideo size={18} />
              </button>
            )}
            {document.pictureInPictureEnabled && (
              <button
                onClick={togglePiP}
                className={cn('p-1.5 rounded transition-colors', isPiP ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10')}
                aria-label={isPiP ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
                title="Picture-in-Picture"
              >
                <PictureInPicture2 size={18} />
              </button>
            )}
            <button onClick={toggleFullscreen} className="text-white/80 hover:text-white p-1.5 rounded hover:bg-white/10 transition-colors">
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Metadata panel (right side on desktop, hidden on mobile) ── */}
      <aside className="hidden lg:flex flex-col w-72 shrink-0 bg-[var(--color-surface)] border-l border-[var(--color-border)] overflow-y-auto">
        <div className="p-4 flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text)] leading-snug">{title}</h2>
            {episodeTitle && (
              <p className="text-sm text-[var(--color-primary-light)] mt-0.5">{episodeTitle}</p>
            )}
          </div>

          <MyListButton item={myListItem} className="self-start" />

          {/* Meta chips */}
          <div className="flex flex-wrap gap-1.5">
            {searchParams.get('year') && (
              <MetaChip icon={Calendar} label={searchParams.get('year')} />
            )}
            {searchParams.get('durationMin') && parseInt(searchParams.get('durationMin')) > 0 && (
              <MetaChip icon={Clock} label={`${searchParams.get('durationMin')} min`} />
            )}
            {searchParams.get('isHD') === 'true' && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-primary)]/20 text-[var(--color-primary-light)] leading-none">HD</span>
            )}
          </div>

          {/* Description */}
          {searchParams.get('description') && (
            <p className="text-xs text-[var(--color-muted)] leading-relaxed">
              {decodeURIComponent(searchParams.get('description'))}
            </p>
          )}

          {/* Director / Actors */}
          {searchParams.get('director') && (
            <div>
              <p className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-0.5">Director</p>
              <p className="text-xs text-[var(--color-text)]">{decodeURIComponent(searchParams.get('director'))}</p>
            </div>
          )}
          {searchParams.get('actors') && (
            <div>
              <p className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-0.5">Cast</p>
              <p className="text-xs text-[var(--color-text)]">{decodeURIComponent(searchParams.get('actors'))}</p>
            </div>
          )}

          {isEpisode && (
            <div className="pt-3 border-t border-[var(--color-border)]">
              <EpisodePanel seasons={seasons} seasonId={panelSeason} onSeason={setPanelSeason} episodes={episodesBySeason[panelSeason]}
                playingSeasonId={seasonId} playingEpisodeId={episodeId} onPlay={playEpisode} />
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

// At the end of an episode: the next one plays in 10 s, unless cancelled.
function UpNextCard({ next, onPlay, onCancel }) {
  const [left, setLeft] = useState(10)
  const onPlayRef = useRef(onPlay)
  useEffect(() => { onPlayRef.current = onPlay })
  useEffect(() => {
    if (left <= 0) { onPlayRef.current(); return }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  const name = next.episode.name || `Episode ${next.episode.seriesNumber}`
  return (
    <div className="absolute right-4 bottom-24 z-30 w-72 rounded-[var(--radius-md)] bg-black/85 backdrop-blur p-3 text-white shadow-xl" onClick={(e) => e.stopPropagation()}>
      <p className="text-[10px] uppercase tracking-wide text-white/60">Up next · in {left}s</p>
      <p className="text-sm font-semibold truncate">{name}</p>
      <p className="text-xs text-white/60 truncate">{next.season.name}</p>
      <div className="flex gap-2 mt-2">
        <button autoFocus onClick={onPlay} className="flex-1 flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] bg-white text-black text-xs font-semibold py-1.5">
          <Play size={12} fill="currentColor" /> Play now
        </button>
        <button onClick={onCancel} className="flex-1 rounded-[var(--radius-sm)] bg-white/15 hover:bg-white/25 text-xs font-medium py-1.5">Cancel</button>
      </div>
    </div>
  )
}

function MetaChip({ icon: Icon, label }) {
  return (
    <span className="flex items-center gap-1 text-[10px] text-[var(--color-muted)] bg-[var(--color-surface-2)] rounded px-1.5 py-0.5">
      <Icon size={9} />
      {label}
    </span>
  )
}
