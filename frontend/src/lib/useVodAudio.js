import { useCallback, useEffect, useRef, useState } from 'react'
import { preferredAudioTrack } from './audioTracks'

/**
 * The movie & series player's audio tracks (lib/audioTracks.js): hls.js's for
 * HLS, the <video>'s own audioTracks for a file where the browser has them
 * (Safari). Chrome and Firefox can't list or switch a file's audio: then
 * `switchable` is false. Each title starts in the `preferred` language where
 * it has a track in it; a track picked by hand wins for that title.
 * `events` is Hls.Events. tracks: [{ id, lang, name, channels }].
 */
export function useVodAudio({ videoRef, hlsRef, events, titleKey, ready, preferred }) {
  const [tracks, setTracks] = useState([])
  const [active, setActive] = useState(-1)
  const [switchable, setSwitchable] = useState(true)
  const pickedRef = useRef(null)      // the title a track was picked by hand in
  const appliedRef = useRef(null)     // `${title}|${language}` the preferred language was applied for

  useEffect(() => { setTracks([]); setActive(-1); setSwitchable(true); pickedRef.current = null; appliedRef.current = null }, [titleKey])

  const select = useCallback((id) => {
    const hls = hlsRef.current
    const v = videoRef.current
    if (hls) { if (hls.audioTrack !== id) hls.audioTrack = id }
    else if (v?.audioTracks) [...v.audioTracks].forEach((t, i) => { t.enabled = i === id })
    else return
    setActive(id)
  }, [hlsRef, videoRef])

  // The tracks, once the media is in (and as hls.js finds or switches them).
  useEffect(() => {
    if (!ready) return
    const v = videoRef.current
    const hls = hlsRef.current
    const native = !hls ? v?.audioTracks : null
    const read = () => {
      if (hls) {
        setTracks((hls.audioTracks || []).map((t, i) => ({ id: i, lang: t.lang || '', name: t.name || '', channels: t.channels || '' })))
        setActive(hls.audioTrack)
        setSwitchable(true)
      } else if (native) {
        const list = [...native]
        setTracks(list.map((t, i) => ({ id: i, lang: t.language || '', name: t.label || '', channels: '' })))
        setActive(list.findIndex((t) => t.enabled))
        setSwitchable(true)
      } else {
        setTracks([])
        setSwitchable(false)
      }
    }
    read()
    if (hls && events) { hls.on(events.AUDIO_TRACKS_UPDATED, read); hls.on(events.AUDIO_TRACK_SWITCHED, read) }
    native?.addEventListener?.('addtrack', read)
    native?.addEventListener?.('change', read)
    return () => {
      if (hls && events) { hls.off(events.AUDIO_TRACKS_UPDATED, read); hls.off(events.AUDIO_TRACK_SWITCHED, read) }
      native?.removeEventListener?.('addtrack', read)
      native?.removeEventListener?.('change', read)
    }
  }, [ready, titleKey, videoRef, hlsRef, events])

  // The preferred language, once the tracks are known — at the start, or when
  // it's changed in the gear — unless a track was picked by hand in this title.
  useEffect(() => {
    if (!ready || preferred == null || tracks.length < 2 || pickedRef.current === titleKey) return
    const at = `${titleKey}|${preferred}`
    if (appliedRef.current === at) return
    appliedRef.current = at
    const id = preferredAudioTrack(tracks, preferred)
    if (id != null && id !== active) select(id)
  }, [ready, preferred, tracks, active, titleKey, select])

  /** A track picked by hand: it plays now, and stays for this title. */
  const pick = useCallback((id) => { pickedRef.current = titleKey; select(id) }, [titleKey, select])

  return { tracks, active, switchable, pick }
}
