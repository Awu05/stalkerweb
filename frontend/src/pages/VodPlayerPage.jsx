import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import Hls from 'hls.js'
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize, AlertCircle, Loader2, Clock, Calendar, X, PictureInPicture2, SkipBack, SkipForward, List, Info, ArrowLeft,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { useSpaceToPlay, isTypingTarget } from '@/lib/useSpaceToPlay'
import { startPlaying } from '@/lib/startPlaying'
import { useSoundOnFirstGesture } from '@/lib/forcedMute'
import ForcedMuteNote from '@/components/ForcedMuteNote'
import { getVodStreamUrl, getVodCastLink, getVodSeasons, getVodEpisodes, getVodSkip } from '../stalkerApi'
import { useCasting } from '@/lib/useCasting'
import { resumeAfterCast } from '@/lib/cast'
import { CastButtons, CastingOverlay } from '@/components/CastControls'
import { formatTime } from '@/lib/formatTime'
import EpisodePanel from '@/components/EpisodePanel'
import { StreamStats, StatsButton } from '@/components/StreamStats'
import { trackHlsStats } from '@/lib/streamStats'
import MyListButton from '@/components/MyListButton'
import { SkipButton, SkipMatch } from '@/components/SkipControls'
import { SubtitleButton, SubtitleMenu } from '@/components/SubtitleMenu'
import { useVodSubtitles } from '@/lib/useVodSubtitles'
import { skipAt, autoSkipTo } from '@/lib/skipSegments'
import { episodeNeighbours } from '@/lib/episodeNav'
import { seasonNoOf, episodeRowLabel, episodeLabel } from '@/lib/seriesProgress'
import { releaseMedia, allowRemotePlayback } from '@/lib/mediaRelease'
import { reportPlayerError, mediaErrorText, hlsErrorText } from '@/lib/playerReport'
import {
  makeVodKey, getVodProgress, saveVodProgress, getWatchState, onWatchChange,
  VOD_RESUME_MIN_SECS, VOD_DONE_FRACTION,
} from '@/lib/vodProgress'

const SEEK_STEP_SECS = 10   // ← / →

// The side panel's open/closed, remembered on this browser (open if unknown).
const SIDE_KEY = 'vodPlayerSidePanel'
function readSideOpen() {
  try { return localStorage.getItem(SIDE_KEY) !== 'closed' } catch { return true }
}
function saveSideOpen(open) {
  try { localStorage.setItem(SIDE_KEY, open ? 'open' : 'closed') } catch { /* private mode */ }
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

  // "S1 · E3 · The Light of Day": the season and episode numbers with the episode's name.
  const episodeName = episodeTitle || seriesNo > 0
    ? episodeLabel({ season: searchParams.get('season') || '', episode: seriesNo > 0 ? String(seriesNo) : '', name: episodeTitle })
    : ''
  const displayTitle = episodeName ? `${title} · ${episodeName}` : title
  const displayTitleRef = useRef(displayTitle)
  displayTitleRef.current = displayTitle

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
  // Casting (lib/useCasting.js): on a Chromecast the TV plays and this page
  // waits, paused; AirPlay plays the <video>'s own source on the Apple TV.
  const onTvRef      = useRef(false)
  const [onTv, setOnTv] = useState(false)
  const castRemoteRef = useRef({ playing: false, time: 0, duration: 0 })
  const afterCastRef  = useRef(null)    // where the TV got to: the stream reloaded here resumes there
  const releasedAtRef = useRef(null)    // { key, at } — where this page was when it let go for the TV
  const onAirplayRef  = useRef(false)
  const containerRef = useRef(null)
  const hideTimer    = useRef(null)
  const volumeRef    = useRef(80)
  // Muted by the viewer (the button, the volume at 0) — what each title starts
  // with. A mute the browser forced (no sound before a click) is the title's alone.
  const userMutedRef = useRef(false)

  const [status, setStatus]           = useState('loading') // loading | playing | paused | error
  const [errorMsg, setErrorMsg]       = useState('')
  const [playing, setPlaying]         = useState(false)
  const [muted, setMuted]             = useState(false)
  const [volume, setVolume]           = useState(80)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration]       = useState(0)
  // Where the seek bar is being dragged to (percent), or null. The video only
  // seeks when the drag ends: one seek, not one per pixel moved, and the
  // playing position can't pull the handle back mid-drag.
  const [scrubPct, setScrubPct]       = useState(null)
  // Which title the video element's media (and so `duration`) belongs to.
  // Switching episode in place keeps this page, and the old episode plays on
  // until the new stream loads: the resume point must wait for the new one.
  const streamKeyRef                  = useRef(null)
  const [mediaKey, setMediaKey]       = useState(null)
  const mediaKeyRef                   = useRef(null)
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
  const [sideOpen, setSideOpen]         = useState(readSideOpen)  // the details/episodes panel on wide screens
  const [statsOpen, setStatsOpen]       = useState(false)
  const statsSources = useCallback(() => ({ hls: hlsRef.current, engine: hlsRef.current ? 'hls.js' : 'browser' }), [])
  const [upNext, setUpNext]             = useState(null)   // { season, episode } after the end
  // What's watched, for the panel's ticks and progress bars.
  const [watchState, setWatchState]     = useState(() => getWatchState())
  useEffect(() => onWatchChange(setWatchState), [])
  const progressOf = (key) => { const p = watchState.progress.find((e) => e.key === key); return p && p.duration > 0 ? Math.min(1, p.position / p.duration) : 0 }
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
  // The show's very last episode: finishing it moves the show to Completed on My
  // List. Only once this episode is actually found in the show's seasons —
  // seasons that failed to load also leave no next episode.
  const found = !!seasons?.some((s) => String(s.id) === String(seasonId))
    && !!episodesBySeason[seasonId]?.some((e) => String(e.episodeId) === String(episodeId))
  const lastEpisode = isEpisode && found && !neighbours.next && neighbours.needs.length === 0
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
    const seasonNo = seasonNoOf(season)
    if (seasonNo) next.set('season', seasonNo); else next.delete('season')
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
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const n = e.code === 'KeyN' ? nextRef.current : e.code === 'KeyP' ? prevRef.current : null
      if (!n) return
      e.preventDefault()
      playEpisodeRef.current(n.season, n.episode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isEpisode])

  useEffect(() => { volumeRef.current = volume }, [volume])

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
    // Not while the previous title's media is still the one playing.
    if (mediaKeyRef.current !== metaRef.current.key) return
    saveVodProgress({ ...metaRef.current, position: v.currentTime, duration: v.duration })
  }, [])

  // Save every 10s while playing, and once more on unmount / title change.
  useEffect(() => {
    const id = setInterval(() => {
      if (onTvRef.current) {
        const r = castRemoteRef.current
        if (r.playing && r.duration > 0 && r.time > 0) saveVodProgress({ ...metaRef.current, position: r.time, duration: r.duration })
      } else if (!videoRef.current?.paused) persist()
    }, 10_000)
    return () => {
      clearInterval(id)
      if (onTvRef.current) {
        const r = castRemoteRef.current
        if (r.duration > 0 && r.time > 0) saveVodProgress({ ...metaRef.current, position: r.time, duration: r.duration })
      } else persist()
    }
  }, [persist, progressKey])

  // Resume once per title, after the duration is known. Re-runs if the user
  // navigates to a different title without the component remounting.
  const resumedKeyRef = useRef(null)
  useEffect(() => {
    const v = videoRef.current
    if (v && duration && mediaKey === progressKey && afterCastRef.current?.key === progressKey) {
      const at = afterCastRef.current.at
      afterCastRef.current = null
      resumedKeyRef.current = progressKey
      try { v.currentTime = at } catch { /* seek rejected */ }
      setResumedFrom(at)
      return
    }
    if (!v || !duration || mediaKey !== progressKey || resumedKeyRef.current === progressKey) return
    resumedKeyRef.current = progressKey
    const saved = getVodProgress(progressKey)
    if (saved && saved.position >= VOD_RESUME_MIN_SECS && saved.position < duration * VOD_DONE_FRACTION) {
      try { v.currentTime = saved.position } catch { /* seek rejected */ }
      setResumedFrom(saved.position)
    } else {
      setResumedFrom(0)
    }
  }, [progressKey, duration, mediaKey])

  // ── Skip intro / recap / credits (lib/skipSegments.js) ──────────────────────
  // The parts that can be skipped, from the server: for this title only
  // (`for`), so the last episode's never show on the next while it loads.
  const [skipFound, setSkipFound] = useState(null)   // { for, imdbId, match, intro, recap, outro, autoSkip }
  const [skipAsk, setSkipAsk]     = useState(0)      // goes up when the show's match is changed
  const seasonNo = searchParams.get('season') || ''
  const year     = searchParams.get('year') || ''
  // The portal's own name, not the "Untitled" shown for none (that would be searched for).
  const portalName = searchParams.get('title') || ''
  useEffect(() => {
    if (!videoId) return
    let cancelled = false
    getVodSkip({ videoId, name: portalName, year, season: seasonNo, episode: isEpisode ? seriesNo : '', movie: !isEpisode })
      .then((r) => { if (!cancelled) setSkipFound({ ...r, for: progressKey }) })
      .catch(() => { if (!cancelled) setSkipFound(null) })
    return () => { cancelled = true }
  }, [videoId, portalName, year, seasonNo, seriesNo, isEpisode, progressKey, skipAsk])
  const skipParts = skipFound?.for === progressKey && mediaKey === progressKey && !onTv ? skipFound : null
  const skipNow = upNext ? null : skipAt(skipParts, currentTime)
  // Auto-skip: each intro or recap once, so going back to watch it stays put.
  // From the video's own position: the state can be a step behind it — still
  // 0 in the render where the resume above has just sought to 20:00, which
  // read as "in the recap" would undo the resume.
  const autoSkippedRef = useRef({ key: null, done: new Set() })
  useEffect(() => {
    const v = videoRef.current
    if (!v || !skipParts?.autoSkip) return
    if (autoSkippedRef.current.key !== progressKey) autoSkippedRef.current = { key: progressKey, done: new Set() }
    const done = autoSkippedRef.current.done
    const at = v.currentTime
    const to = autoSkipTo(skipParts, at, done)
    if (to == null) return
    done.add(skipAt(skipParts, at).kind)
    try { v.currentTime = Math.min(to, v.duration) } catch { /* seek rejected */ }
  }, [skipParts, currentTime, progressKey])
  // ── Subtitles: the video's own, or OpenSubtitles' (lib/useVodSubtitles.js) ──
  const [subsOpen, setSubsOpen] = useState(false)
  const subs = useVodSubtitles({
    videoRef, hlsRef, events: Hls.Events, titleKey: progressKey,
    query: { videoId, name: portalName, year, season: seasonNo, episode: isEpisode ? seriesNo : '', movie: !isEpisode },
    ready: mediaKey === progressKey && !onTv,
  })
  useEffect(() => { setSubsOpen(false) }, [progressKey])

  function doSkip(toNextEpisode) {
    if (toNextEpisode && neighbours.next) { playEpisode(neighbours.next.season, neighbours.next.episode); return }
    const v = videoRef.current
    if (!v || !skipNow) return
    const t = Math.min(skipNow.to, v.duration)
    try { v.currentTime = t } catch { /* seek rejected */ }
    setCurrentTime(t)
  }

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
    if (onTv) return

    let cancelled = false
    setStatus('loading')
    setErrorMsg('')
    // A new title: what's on screen until it loads is the old one's.
    streamKeyRef.current = makeVodKey({ videoId, seasonId, episodeId })
    mediaKeyRef.current = null
    setMediaKey(null)
    setScrubPct(null)

    getVodStreamUrl({ videoId, cmd, series: seriesNo, seasonId, episodeId })
      .then(({ streamUrl }) => {
        if (!cancelled) loadStreamUrl(streamUrl)
      })
      .catch(e => {
        if (!cancelled) { setStatus('error'); setErrorMsg(e.message) }
      })

    return () => { cancelled = true }
  }, [videoId, cmd, seriesNo, seasonId, episodeId, onTv])

  function loadStreamUrl(url) {
    const video = videoRef.current
    if (!video || onAirplayRef.current) return

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }

    // Each title starts with the viewer's own mute (startPlaying), never a mute
    // the browser forced on the last; the mute shown follows what it ends up with.

    // With sound unless the viewer muted it; muted only if the browser refuses
    // sound before a click — not because a newer load cut a play short (lib/startPlaying.js).
    const tryPlay = () => leftRef.current || onTvRef.current ? Promise.resolve() :
      startPlaying(video, { userMuted: userMutedRef.current }).then((r) => {
        if (!r || leftRef.current) return
        setMuted(r.muted)
        if (r.playing) { setStatus('playing'); setPlaying(true); return }
        setPlaying(false)
        // A file this browser can't play says so; one it only won't start without a click waits for one.
        if (r.error && r.error !== 'NotAllowedError') { setStatus('error'); setErrorMsg(`This video can't be played in this browser (${r.error}).`) }
        else setStatus('paused')
      })

    const playNative = (src) => {
      allowRemotePlayback(video)
      video.src = src
      video.volume = volumeRef.current / 100
      video.muted  = userMutedRef.current
      tryPlay()
    }

    const isNative = /\.(mp4|mkv|avi|mov|webm|ts|mpg|mpeg|mp2|m4v)(\?|$)/i.test(url)
    if (isNative) { playNative(url); return }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, subtitleDisplay: false })   // subtitles shown only when picked (lib/useVodSubtitles.js)
      hlsRef.current = hls
      trackHlsStats(hls, Hls.Events)
      let lastRecover = 0   // one recoverMediaError a minute (a film's hiccups are hours apart; a video that can't be decoded fails at once)
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.volume = volumeRef.current / 100
        video.muted  = userMutedRef.current
        tryPlay()
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          const t = hlsErrorText(data)
          reportPlayerError({ title: displayTitleRef.current, engine: 'hls.js', kind: t.kind, detail: t.detail })
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && Date.now() - lastRecover > 60_000) {
            lastRecover = Date.now()
            hls.recoverMediaError()
            if (video.paused && !leftRef.current) tryPlay()   // the play it cut short
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // Can't be decoded here: the device's own player (Safari's takes
            // formats the page player won't) from where it was, or say so.
            const at = video.currentTime
            hls.destroy(); hlsRef.current = null
            if (video.canPlayType('application/vnd.apple.mpegurl')) {
              if (at > 0) video.addEventListener('loadedmetadata', () => { try { video.currentTime = at } catch { /* seek rejected */ } }, { once: true })
              playNative(url)
            } else { setStatus('error'); setErrorMsg(`This video can't be played on this device (${t.detail || 'decode failed'}).`) }
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
    const onDur    = () => { setDuration(v.duration || 0); mediaKeyRef.current = streamKeyRef.current; setMediaKey(streamKeyRef.current) }
    const onPlay   = () => { setPlaying(true); setStatus('playing') }
    const onPause  = () => { setPlaying(false); setStatus('paused') }
    const onEnded  = () => { setPlaying(false); setStatus('paused'); if (nextRef.current) setUpNext(nextRef.current) }
    // The <video>'s own error — to the server log (lib/playerReport.js).
    const onError  = () => {
      const text = mediaErrorText(v)
      if (text) reportPlayerError({ title: displayTitleRef.current, engine: v.src.startsWith('blob:') ? 'hls.js' : 'native', kind: 'video error', detail: text })
    }
    v.addEventListener('error',            onError)
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
      v.removeEventListener('error',          onError)
    }
  }, [])

  // Leaving the player: hls.js gone, and the video paused with its source and
  // connection let go (a movie or episode played straight from its file would
  // otherwise carry on with nothing on screen — lib/mediaRelease.js).
  const leftRef = useRef(false)
  useEffect(() => {
    const video = videoRef.current
    // Mounted (again: StrictMode's dev mount → unmount → mount would otherwise
    // leave it "left", and nothing would ever play).
    leftRef.current = false
    return () => { leftRef.current = true; hlsRef.current?.destroy(); releaseMedia(video) }
  }, [])

  // Auto-hide controls when playing fullscreen
  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimer.current)
    if (playing && isFullscreen) {
      hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    }
  }, [playing, isFullscreen])

  useEffect(() => { resetHideTimer(); return () => clearTimeout(hideTimer.current) }, [resetHideTimer])

  // Space: play / pause, on the video or its controls (lib/useSpaceToPlay.js).
  useSpaceToPlay(togglePlayPause)

  // ← / →: back or forward 10 seconds. Not while typing, or on a slider (the
  // seek bar and volume take the arrows themselves).
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return
      if (isTypingTarget(e.target) ||
          e.target.closest?.('[role="slider"]') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const v = videoRef.current
      if (!v || !Number.isFinite(v.duration)) return
      e.preventDefault()
      const t = Math.min(Math.max(v.currentTime + (e.code === 'ArrowRight' ? SEEK_STEP_SECS : -SEEK_STEP_SECS), 0), v.duration)
      try { v.currentTime = t } catch { /* seek rejected */ }
      setCurrentTime(t)
      resetHideTimer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetHideTimer])

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

  const cast = useCasting({
    videoRef,
    mediaKey: progressKey,
    ready: mediaKey === progressKey,   // AirPlay's link once this page's own stream has resolved (not both at once)
    getLink: () => getVodCastLink({ videoId, cmd, series: seriesNo, seasonId, episodeId }),
    getMeta: () => {
      const v = videoRef.current
      // Where this title is: the page's position if it's the one loaded, else where it was left off.
      const here = v && mediaKeyRef.current === progressKey ? v.currentTime
        : releasedAtRef.current?.key === progressKey ? releasedAtRef.current.at
        : (getVodProgress(progressKey)?.position || 0)
      return { title, subtitle: episodeTitle, image: myListItem.screenshotUrl, startSecs: here }
    },
    // The TV plays it: this page lets go of the stream (some allow one
    // connection per link), remembering where it was.
    onTvStart: () => {
      persist()
      const v = videoRef.current
      if (v && mediaKeyRef.current === progressKey) releasedAtRef.current = { key: progressKey, at: v.currentTime }
      onTvRef.current = true
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
      releaseMedia(v)
      mediaKeyRef.current = null
      setMediaKey(null)
      setOnTv(true)
    },
    onTvEnd: (time, dur) => {
      onTvRef.current = false
      releasedAtRef.current = null
      const at = resumeAfterCast(time, dur)
      afterCastRef.current = at != null ? { key: progressKey, at } : null
      resumedKeyRef.current = null
      setOnTv(false)   // the stream loads again, and resumes there
    },
    toNative: (url) => {
      const v = videoRef.current
      if (!v) return
      // This title's position, or — a new episode — where it was left off.
      const saved = getVodProgress(progressKey)?.position || 0
      const at = mediaKeyRef.current === progressKey ? v.currentTime : saved >= VOD_RESUME_MIN_SECS ? saved : 0
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
      allowRemotePlayback(v)
      v.src = url
      if (at > 0) v.addEventListener('loadedmetadata', () => { try { v.currentTime = at } catch { /* seek rejected */ } }, { once: true })
      v.play().catch(() => {})
    },
  })
  castRemoteRef.current = cast.remote
  onAirplayRef.current = cast.mode === 'airplay'

  // Muted by the browser, not the viewer (no click yet): the first click or key brings the sound back.
  // (Every mute the viewer sets goes with setMuted, so this follows it.)
  const soundBlocked = muted && !userMutedRef.current && !onTv
  useSoundOnFirstGesture(soundBlocked, videoRef, setMuted, { onPicture: resetHideTimer })

  function togglePlayPause() {
    if (onTv) { cast.togglePlay(); return }
    const v = videoRef.current; if (!v) return
    if (!v.paused) { v.pause(); return }
    // As a title starts (lib/startPlaying.js): with the viewer's own sound.
    startPlaying(v, { userMuted: userMutedRef.current }).then((r) => { if (r) setMuted(r.muted) })
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
    const t = (pct / 100) * duration
    v.currentTime = t
    setCurrentTime(t)   // the handle stays where it was dropped while the video catches up
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0
  const shownTime = scrubPct != null ? (scrubPct / 100) * duration : currentTime
  // The bar goes away with the duration (a new title loading): a drag in
  // progress then can't end, so it's dropped.
  useEffect(() => { if (!duration) setScrubPct(null) }, [duration])

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100dvh-3.5rem)] lg:h-dvh bg-black">

      {/* ── Video panel ── */}
      <div
        ref={containerRef}
        className="relative flex-1 flex flex-col bg-black"
        onMouseMove={resetHideTimer}
        onMouseLeave={() => clearTimeout(hideTimer.current)}
      >
        {/* Back button (always visible, top-left) */}
        <div className={cn(
          'absolute top-0 inset-x-0 z-20 flex items-center gap-2 h-14 px-3 bg-gradient-to-b from-black/60 to-transparent transition-opacity duration-300',   // h-14: level with the sidebar's header
          showControls || status !== 'playing' ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}>
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 text-white/80 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft size={18} />
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

        {soundBlocked && status === 'playing' && <ForcedMuteNote className={resumedFrom > 0 ? 'top-24' : undefined} />}  {/* below the resumed-from banner */}

        {/* Video element */}
        {/* The video is pinned to this area's edges: sized from its own width
            instead, a 16:9 picture on an ultrawide screen in fullscreen came out
            taller than the screen and lost its top and bottom. */}
        <div
          className="relative flex-1 min-h-0 cursor-pointer"
          onClick={togglePlayPause}
        >
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline />
          <StreamStats open={statsOpen && !cast.mode} onClose={() => setStatsOpen(false)} videoRef={videoRef} sources={statsSources}
            kind="vod" id={makeVodKey({ videoId, seasonId, episodeId })} />
          <CastingOverlay cast={cast} />
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

        {subsOpen && !onTv && (
          <SubtitleMenu embedded={subs.embedded} online={subs.online} choice={subs.choice}
            onPick={(kind, id, language) => subs.pick(kind, id, language)}
            delay={subs.delay} onDelay={subs.setDelay} onClose={() => setSubsOpen(false)} />
        )}

        <SkipButton skip={skipNow} onSkip={doSkip} nextEpisode={!!neighbours.next} raised={showControls || status !== 'playing'} />

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
                playingSeasonId={seasonId} playingEpisodeId={episodeId} onPlay={playEpisode}
                showId={videoId} watchedEpisodes={watchState.watchedEpisodes} progressOf={progressOf} />
            </div>
          </div>
        )}

        {/* Controls bar (the local video's — hidden while a Chromecast plays it: the overlay has the TV's) */}
        <div data-player-controls className={cn(
          'absolute bottom-0 inset-x-0 z-20 transition-opacity duration-300',
          onTv ? 'hidden' : showControls || status !== 'playing' ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}>
          {/* Seek bar */}
          {duration > 0 && (
            <div className="px-4 pb-1" onClick={e => e.stopPropagation()}>
              {/* py-2.5: a taller target than the 4px track, so a click just
                  off it seeks instead of landing on the video and pausing. */}
              <Slider
                min={0} max={100} step={0.1}
                value={[scrubPct ?? progressPct]}
                onValueChange={([v]) => setScrubPct(v)}
                onValueCommit={([v]) => { seek(v); setScrubPct(null) }}
                aria-label="Seek"
                className="w-full py-2.5 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-white/50">
                <span>{formatTime(shownTime)}</span>
                <span>-{formatTime(duration - shownTime)}</span>
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
            <button aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlayPause} className="text-white/90 hover:text-white p-1 transition-colors">
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
              <button data-mute-button aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'} onClick={() => setMuted(m => { userMutedRef.current = !m; return !m })} className="text-white/90 hover:text-white p-1 transition-colors">
                {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <div className="w-0 overflow-hidden group-hover/vol:w-20 transition-all duration-200">
                <Slider min={0} max={100} step={1} value={[muted ? 0 : volume]}
                  onValueChange={([v]) => { setVolume(v); setMuted(false); userMutedRef.current = false }} className="w-20" />
              </div>
            </div>
            <div className="flex-1" />
            {isEpisode && (
              <button onClick={() => setEpisodesOpen(true)} className="lg:hidden text-white/80 hover:text-white p-1.5 rounded hover:bg-white/10 transition-colors" aria-label="Episodes" title="Episodes">
                <List size={18} />
              </button>
            )}
            <button
              onClick={() => setSideOpen(o => { saveSideOpen(!o); return !o })}
              className={cn('hidden lg:inline-flex p-1.5 rounded transition-colors', sideOpen ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10')}
              aria-label={sideOpen ? 'Hide panel' : 'Show panel'} aria-pressed={sideOpen}
              title={sideOpen ? (isEpisode ? 'Hide episodes' : 'Hide details') : (isEpisode ? 'Show episodes' : 'Show details')}
            >
              {/* The episode list, as the apps show it (a movie's panel is its details) */}
              {isEpisode ? <List size={18} /> : <Info size={18} />}
            </button>
            <SubtitleButton on={subs.choice.kind !== 'off'} open={subsOpen}
              onToggle={() => { if (!subsOpen) subs.loadOnline(); setSubsOpen(o => !o) }} />
            <StatsButton open={statsOpen} onToggle={() => setStatsOpen(o => !o)} />
            <CastButtons cast={cast} />
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
            <button aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen} className="text-white/80 hover:text-white p-1.5 rounded hover:bg-white/10 transition-colors">
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Metadata panel (right side on desktop, hidden on mobile) ── */}
      <aside className={cn('hidden flex-col w-72 shrink-0 bg-[var(--color-surface)] border-l border-[var(--color-border)] overflow-y-auto', sideOpen && 'lg:flex')}>
        <div className="p-4 flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text)] leading-snug">{title}</h2>
            {episodeName && (
              <p className="text-sm text-[var(--color-primary-light)] mt-0.5">{episodeName}</p>
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

          <SkipMatch videoId={videoId} found={skipFound?.for === progressKey ? skipFound : null} onChanged={() => setSkipAsk((n) => n + 1)} />

          {isEpisode && (
            <div className="pt-3 border-t border-[var(--color-border)]">
              <EpisodePanel seasons={seasons} seasonId={panelSeason} onSeason={setPanelSeason} episodes={episodesBySeason[panelSeason]}
                playingSeasonId={seasonId} playingEpisodeId={episodeId} onPlay={playEpisode}
                showId={videoId} watchedEpisodes={watchState.watchedEpisodes} progressOf={progressOf} />
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
  const name = episodeRowLabel(next.episode)
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
