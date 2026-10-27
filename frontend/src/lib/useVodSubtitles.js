import { useCallback, useEffect, useRef, useState } from 'react'
import { getVodSubtitles } from '../stalkerApi'
import {
  savedChoice, saveChoice, startingChoice, savedDelay, saveDelay, clampDelay, subtitleFileUrl,
} from './subtitles'

// The <track> added for an online subtitle file — told apart from the video's own by its label.
const ONLINE_LABEL = 'OpenSubtitles'
const NO_ONLINE = { for: null, loading: false, configured: null, results: [], error: '' }

/**
 * The VOD player's subtitles (lib/subtitles.js): the video's own — hls.js's
 * subtitle tracks, or the <video>'s text tracks — and OpenSubtitles' through
 * the server, added as a <track>. Each title starts with what was picked
 * last (the same language), once its media is `ready`. `query` is the
 * title's getVodSubtitles query; `events` is Hls.Events.
 */
export function useVodSubtitles({ videoRef, hlsRef, events, titleKey, query, ready }) {
  const [embedded, setEmbedded] = useState([])
  const [online, setOnline] = useState(NO_ONLINE)
  const [choice, setChoice] = useState({ kind: 'off', id: null })
  const [delay, setDelayState] = useState(savedDelay)
  const trackRef = useRef(null)
  const startedRef = useRef(null)     // the title the starting choice was made for
  const queryRef = useRef(query)
  queryRef.current = query

  const removeOnline = useCallback(() => {
    trackRef.current?.remove()
    trackRef.current = null
  }, [])

  // A new title: nothing chosen yet, and the last one's file gone.
  useEffect(() => {
    setEmbedded([])
    setOnline(NO_ONLINE)
    setChoice({ kind: 'off', id: null })
    removeOnline()
  }, [titleKey, removeOnline])

  // The video's own, once its media is in (and as more are found).
  useEffect(() => {
    if (!ready) return
    const v = videoRef.current
    const hls = hlsRef.current
    const read = () => {
      if (hls) {
        setEmbedded((hls.subtitleTracks || []).map((t, i) => ({ id: i, label: t.name || '', language: t.lang || '' })))
      } else if (v) {
        setEmbedded([...v.textTracks]
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => (t.kind === 'subtitles' || t.kind === 'captions') && t.label !== ONLINE_LABEL)
          .map(({ t, i }) => ({ id: i, label: t.label || '', language: t.language || '' })))
      }
    }
    read()
    if (hls && events) hls.on(events.SUBTITLE_TRACKS_UPDATED, read)
    v?.textTracks?.addEventListener?.('addtrack', read)
    return () => {
      if (hls && events) hls.off(events.SUBTITLE_TRACKS_UPDATED, read)
      v?.textTracks?.removeEventListener?.('addtrack', read)
    }
  }, [ready, titleKey, videoRef, hlsRef, events])

  /** OpenSubtitles' list for this title, asked once. */
  const loadOnline = useCallback(() => {
    if (online.for === titleKey) return
    const key = titleKey
    setOnline({ ...NO_ONLINE, for: key, loading: true })
    getVodSubtitles(queryRef.current)
      .then((r) => setOnline((o) => (o.for === key ? { for: key, loading: false, configured: !!r.configured, results: r.results || [], error: r.error || '' } : o)))
      .catch((e) => setOnline((o) => (o.for === key ? { for: key, loading: false, configured: true, results: [], error: e.message } : o)))
  }, [online.for, titleKey])

  // Showing one: the others off.
  const apply = useCallback((kind, id, language, d) => {
    const v = videoRef.current
    const hls = hlsRef.current
    if (!v) return
    removeOnline()
    if (hls) hls.subtitleTrack = kind === 'embedded' ? id : -1
    if (!hls) [...v.textTracks].forEach((t, i) => { t.mode = kind === 'embedded' && i === id ? 'showing' : 'disabled' })
    if (hls && kind === 'embedded') hls.subtitleDisplay = true
    if (kind === 'online') {
      const el = document.createElement('track')
      el.kind = 'subtitles'
      el.label = ONLINE_LABEL
      el.srclang = language || 'en'
      el.src = subtitleFileUrl(id, d)
      v.appendChild(el)
      el.track.mode = 'showing'
      trackRef.current = el
    }
  }, [videoRef, hlsRef, removeOnline])

  /** A viewer's pick — kept for the next title. */
  const pick = useCallback((kind, id = null, language = '') => {
    apply(kind, id, language, delay)
    setChoice({ kind, id, language })
    saveChoice(kind, kind === 'off' ? '' : language)
  }, [apply, delay])

  const setDelay = useCallback((d) => {
    const next = clampDelay(d)
    setDelayState(next)
    saveDelay(next)
    if (choice.kind === 'online') apply('online', choice.id, choice.language, next)
  }, [apply, choice])

  // Each title starts with the language picked last: asks OpenSubtitles when
  // the video has none in it.
  useEffect(() => {
    if (!ready || startedRef.current === titleKey) return
    const saved = savedChoice()
    if (saved.kind === 'off') { startedRef.current = titleKey; return }
    const now = startingChoice(saved, embedded, [])
    if (now) { startedRef.current = titleKey; apply(now.kind, now.id, saved.language, delay); setChoice({ ...now, language: saved.language }); return }
    if (online.for !== titleKey) { loadOnline(); return }
    if (online.loading) return
    startedRef.current = titleKey
    const fetched = startingChoice(saved, [], online.results)
    if (fetched) { apply(fetched.kind, fetched.id, saved.language, delay); setChoice({ ...fetched, language: saved.language }) }
  }, [ready, titleKey, embedded, online, loadOnline, apply, delay])

  // Leaving the player: the <track> goes with it.
  useEffect(() => removeOnline, [removeOnline])

  return { embedded, online, choice, delay, pick, setDelay, loadOnline }
}
