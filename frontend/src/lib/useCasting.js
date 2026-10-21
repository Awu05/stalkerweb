import { useCallback, useEffect, useRef, useState } from 'react'
import { airplaySupported, castRequestOf, chromecastSupported, loadCastSdk } from './cast'
import { showToast } from './toast'

// Chromecast and AirPlay for a player page (lib/cast.js).
//
// The page says what it plays (mediaKey, getLink, getMeta) and how to hand
// over: onTvStart() — the TV has it, stop playing here (Chromecast); onTvEnd(t,
// d) — back here, from where the TV got to; release(key) — the TV left that
// one (the server can let go of it); toNative(url) — play this plain link in
// the <video> (AirPlay sends the element's own source to the Apple TV, and
// hls.js / mpegts.js sources can't be sent). ready: false holds AirPlay's
// link fetch back (until the page's own stream has resolved).

let optionsSet = false

/** A remote player's state worth a re-render: playing, a whole second, the duration. */
const sameRemote = (a, b) => a.playing === b.playing && Math.floor(a.time) === Math.floor(b.time) && a.duration === b.duration

export function useCasting({ videoRef, mediaKey, getLink, getMeta, onTvStart, onTvEnd, release, toNative, ready = true }) {
  const fns = useRef({})
  fns.current = { getLink, getMeta, onTvStart, onTvEnd, release, toNative }
  const keyRef = useRef(mediaKey)
  keyRef.current = mediaKey

  // ── Chromecast ──────────────────────────────────────────────────────────
  const [cc, setCc] = useState({ available: false, casting: false, device: null })
  const [ours, setOurs] = useState(false)   // a session this page started (not one joined from another tab)
  const [remote, setRemote] = useState({ playing: false, time: 0, duration: 0 })
  const ctxRef = useRef(null)
  const playerRef = useRef(null)
  const controllerRef = useRef(null)
  const oursRef = useRef(false)
  const onTvKeyRef = useRef(null)          // what the TV was last sent
  const lastGoodRef = useRef({ time: 0, duration: 0 })   // its last real position (reset to 0 once a session ends)
  const loadNoRef = useRef(0)
  const unlistenRef = useRef(null)

  const endOurs = useCallback(() => {
    if (!oursRef.current) return
    oursRef.current = false
    setOurs(false)
    const left = onTvKeyRef.current
    onTvKeyRef.current = null
    if (left) fns.current.release?.(left)
    const { time, duration } = lastGoodRef.current
    lastGoodRef.current = { time: 0, duration: 0 }
    fns.current.onTvEnd?.(time, duration)
  }, [])

  const load = useCallback(async () => {
    const session = ctxRef.current?.getCurrentSession()
    const chrome = globalThis.chrome
    if (!session || !chrome?.cast || !oursRef.current) return
    const no = ++loadNoRef.current
    const key = keyRef.current
    try {
      const link = await fns.current.getLink()
      if (no !== loadNoRef.current) return   // a newer channel or episode was asked for meanwhile
      const r = castRequestOf(link, fns.current.getMeta?.() || {})
      const info = new chrome.cast.media.MediaInfo(r.url, r.contentType)
      info.streamType = r.live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED
      const meta = new chrome.cast.media.GenericMediaMetadata()
      meta.title = r.title
      if (r.subtitle) meta.subtitle = r.subtitle
      if (r.image) meta.images = [new chrome.cast.Image(r.image)]
      info.metadata = meta
      const req = new chrome.cast.media.LoadRequest(info)
      req.autoplay = true
      req.currentTime = r.startSecs
      const before = onTvKeyRef.current
      onTvKeyRef.current = key
      lastGoodRef.current = { time: 0, duration: 0 }
      if (before && before !== key) fns.current.release?.(before)
      await session.loadMedia(req)
    } catch (e) {
      if (no !== loadNoRef.current) return     // replaced by the next load: not a failure
      // Nothing plays anywhere now: end the cast, so the page plays it again.
      showToast(typeof e === 'string' ? `The TV couldn't play this (${e})` : e?.message || "Couldn't cast this", 'error')
      ctxRef.current?.endCurrentSession(true)
      endOurs()
    }
  }, [endOurs])

  useEffect(() => {
    if (!chromecastSupported()) return
    let off = false
    loadCastSdk().then((ok) => {
      const { cast, chrome } = globalThis
      if (off || !ok || !cast?.framework) return
      const ctx = cast.framework.CastContext.getInstance()
      if (!optionsSet) {
        ctx.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED })
        optionsSet = true
      }
      ctxRef.current = ctx
      const player = new cast.framework.RemotePlayer()
      const controller = new cast.framework.RemotePlayerController(player)
      playerRef.current = player
      controllerRef.current = controller
      const S = cast.framework.CastState
      const onState = () => {
        const st = ctx.getCastState()
        const casting = st === S.CONNECTED
        setCc({ available: st !== S.NO_DEVICES_AVAILABLE, casting, device: ctx.getCurrentSession()?.getCastDevice()?.friendlyName || null })
        if (!casting) endOurs()
      }
      const onRemote = () => {
        const next = {
          playing: !player.isPaused && player.playerState !== 'IDLE' && !!player.isMediaLoaded,
          time: player.currentTime || 0,
          duration: player.duration || 0,
        }
        if (next.time > 0) lastGoodRef.current = { time: next.time, duration: next.duration }
        setRemote((r) => (sameRemote(r, next) ? r : next))
      }
      ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onState)
      controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, onRemote)
      onState()
      unlistenRef.current = () => {
        ctx.removeEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onState)
        controller.removeEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, onRemote)
      }
    })
    return () => { off = true; unlistenRef.current?.(); unlistenRef.current = null }
  }, [endOurs])

  // Ours and connected: the TV plays what's on this page, and follows it.
  useEffect(() => { if (ours && cc.casting && mediaKey) load() }, [ours, cc.casting, mediaKey, load])

  const startChromecast = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const take = () => {
      if (oursRef.current) return
      oursRef.current = true
      setOurs(true)
      fns.current.onTvStart?.()
    }
    // Already connected (a session joined from another tab): this page takes it over.
    if (ctx.getCastState() === globalThis.cast?.framework?.CastState?.CONNECTED) { take(); return }
    ctx.requestSession().then(take).catch((e) => {
      if (e !== 'cancel') showToast("Couldn't connect to the TV", 'error')
    })
  }, [])
  const stopChromecast = useCallback(() => { ctxRef.current?.endCurrentSession(true) }, [])
  const togglePlay = useCallback(() => { controllerRef.current?.playOrPause() }, [])
  const seekTo = useCallback((secs) => {
    const p = playerRef.current
    if (!p) return
    p.currentTime = Math.max(0, secs)
    controllerRef.current?.seek()
  }, [])

  // ── AirPlay ─────────────────────────────────────────────────────────────
  const [ap, setAp] = useState({ available: false, active: false })
  const linkRef = useRef(null)   // { key, url } or { key, error } — ready before the tap: the picker must open in the tap itself

  useEffect(() => {
    const v = videoRef.current
    if (!v || !airplaySupported()) return
    const onAvail = (e) => setAp((a) => ({ ...a, available: e.availability === 'available' }))
    const onWireless = () => setAp((a) => ({ ...a, active: !!v.webkitCurrentPlaybackTargetIsWireless }))
    v.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail)
    v.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless)
    return () => {
      v.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail)
      v.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless)
    }
  }, [videoRef])

  const apActiveRef = useRef(false)
  apActiveRef.current = ap.active
  useEffect(() => {
    if (!ap.available || !mediaKey || !(ready || ap.active)) return
    let off = false
    fns.current.getLink()
      .then((link) => {
        if (off) return
        const url = castRequestOf(link).url
        linkRef.current = { key: mediaKey, url }
        // Already on the Apple TV: the new channel or episode goes there too.
        if (apActiveRef.current) fns.current.toNative?.(url)
      })
      .catch((e) => { if (!off) linkRef.current = { key: mediaKey, error: e?.message || "Couldn't get this ready for AirPlay" } })
    return () => { off = true }
  }, [ap.available, ap.active, mediaKey, ready])

  const startAirplay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const l = linkRef.current?.key === mediaKey ? linkRef.current : null
    if (l?.error) { showToast(l.error, 'error'); return }
    if (!l?.url) { showToast('Getting ready for AirPlay — try again in a moment'); return }
    if (v.currentSrc !== l.url) fns.current.toNative?.(l.url)
    v.webkitShowPlaybackTargetPicker?.()
  }, [videoRef, mediaKey])

  const chromecasting = ours && cc.casting
  const mode = chromecasting ? 'chromecast' : ap.active ? 'airplay' : null
  return {
    mode,
    device: chromecasting ? cc.device : ap.active ? 'Apple TV' : null,
    remote,
    chromecast: { available: cc.available, start: startChromecast, stop: stopChromecast },
    airplay: { available: ap.available, start: startAirplay },
    togglePlay,
    seekTo,
  }
}
