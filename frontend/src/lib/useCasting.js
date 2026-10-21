import { useCallback, useEffect, useRef, useState } from 'react'
import { airplaySupported, castRequestOf, chromecastSupported, loadCastSdk } from './cast'
import { showToast } from './toast'

// Chromecast and AirPlay for a player page (lib/cast.js).
//
// The page says what it plays (mediaKey, getLink, getMeta) and how to hand
// over: onTvStart() — the TV has it, stop playing here (Chromecast); onTvEnd(t)
// — back here, from where the TV got to; toNative(url) — play this plain link
// in the <video> (AirPlay sends the element's own source to the Apple TV, and
// hls.js / mpegts.js sources can't be sent).

let optionsSet = false

export function useCasting({ videoRef, mediaKey, getLink, getMeta, onTvStart, onTvEnd, toNative }) {
  const fns = useRef({})
  fns.current = { getLink, getMeta, onTvStart, onTvEnd, toNative }

  // ── Chromecast ──────────────────────────────────────────────────────────
  const [cc, setCc] = useState({ available: false, casting: false, device: null })
  const [remote, setRemote] = useState({ playing: false, time: 0, duration: 0 })
  const ctxRef = useRef(null)
  const playerRef = useRef(null)
  const controllerRef = useRef(null)
  const castingRef = useRef(false)
  const unlistenRef = useRef(null)
  const remoteRef = useRef(remote)
  remoteRef.current = remote

  const load = useCallback(async () => {
    const session = ctxRef.current?.getCurrentSession()
    const chrome = globalThis.chrome
    if (!session || !chrome?.cast) return
    try {
      const link = await fns.current.getLink()
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
      await session.loadMedia(req)
    } catch (e) {
      showToast(typeof e === 'string' ? `The TV couldn't play this (${e})` : e?.message || "Couldn't cast this", 'error')
    }
  }, [])

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
        if (casting && !castingRef.current) { castingRef.current = true; fns.current.onTvStart?.() }
        if (!casting && castingRef.current) { castingRef.current = false; fns.current.onTvEnd?.(remoteRef.current.time, remoteRef.current.duration) }
      }
      const onRemote = () => setRemote({
        playing: !player.isPaused && player.playerState !== 'IDLE' && !!player.isMediaLoaded,
        time: player.currentTime || 0,
        duration: player.duration || 0,
      })
      ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onState)
      controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, onRemote)
      onState()
      unlistenRef.current = () => {
        ctx.removeEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onState)
        controller.removeEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, onRemote)
      }
    })
    return () => { off = true; unlistenRef.current?.(); unlistenRef.current = null }
  }, [])

  // Another channel or episode while casting: the TV follows.
  useEffect(() => { if (cc.casting && mediaKey) load() }, [cc.casting, mediaKey, load])

  const startChromecast = useCallback(() => {
    ctxRef.current?.requestSession().catch((e) => {
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
  const linkRef = useRef(null)   // { key, url } — ready before the tap: the picker must open in the tap itself

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
    if (!ap.available || !mediaKey) return
    let off = false
    fns.current.getLink()
      .then((link) => {
        if (off) return
        const url = castRequestOf(link).url
        linkRef.current = { key: mediaKey, url }
        // Already on the Apple TV: the new channel or episode goes there too.
        if (apActiveRef.current) fns.current.toNative?.(url)
      })
      .catch(() => {})
    return () => { off = true }
  }, [ap.available, mediaKey])

  const startAirplay = useCallback(() => {
    const v = videoRef.current
    const ready = linkRef.current?.key === mediaKey ? linkRef.current.url : null
    if (!v) return
    if (!ready) { showToast('Getting ready for AirPlay — try again in a moment'); return }
    if (v.currentSrc !== ready) fns.current.toNative?.(ready)
    v.webkitShowPlaybackTargetPicker?.()
  }, [videoRef, mediaKey])

  const mode = cc.casting ? 'chromecast' : ap.active ? 'airplay' : null
  return {
    mode,
    device: cc.casting ? cc.device : ap.active ? 'Apple TV' : null,
    remote,
    chromecast: { available: cc.available, start: startChromecast, stop: stopChromecast },
    airplay: { available: ap.available, start: startAirplay },
    togglePlay,
    seekTo,
  }
}
