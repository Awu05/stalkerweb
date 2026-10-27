import { useCallback, useEffect, useRef, useState } from 'react'
import { getVodSubtitles } from '../stalkerApi'
import {
  savedChoice, saveChoice, startingChoice, savedDelay, saveDelay, clampDelay, subtitleFileUrl,
} from './subtitles'

// The <track> added for an online subtitle file — told apart from the video's own by its label.
const ONLINE_LABEL = 'Online subtitles'
const NO_ONLINE = { for: null, loading: false, configured: null, provider: '', results: [], error: '' }
const OFF = { kind: 'off', id: null, language: '' }
const DELAY_SETTLE_MS = 800   // after the last delay press

/**
 * The VOD player's subtitles (lib/subtitles.js): the video's own — hls.js's
 * subtitle tracks, or the <video>'s text tracks — and the online ones through
 * the server, added as a <track>. Each title starts with what was picked
 * last (the same language), once its media is `ready`. `query` is the
 * title's getVodSubtitles query; `events` is Hls.Events.
 */
export function useVodSubtitles({ videoRef, hlsRef, events, titleKey, query, ready }) {
  const [embedded, setEmbedded] = useState([])
  const [embeddedFor, setEmbeddedFor] = useState(null)   // the title whose own tracks have been read
  const [online, setOnline] = useState(NO_ONLINE)
  const [choice, setChoiceState] = useState(OFF)
  const choiceRef = useRef(OFF)
  const [delay, setDelayState] = useState(savedDelay)
  const trackRef = useRef(null)
  const startedRef = useRef(null)     // the title whose subtitles have been chosen, by the viewer or to start with
  const queryRef = useRef(query)
  queryRef.current = query

  const setChoice = useCallback((c) => { choiceRef.current = c; setChoiceState(c) }, [])

  const removeOnline = useCallback(() => {
    trackRef.current?.remove()
    trackRef.current = null
  }, [])

  // A new title: nothing chosen yet, and the last one's file gone.
  useEffect(() => {
    setEmbedded([])
    setEmbeddedFor(null)
    setOnline(NO_ONLINE)
    setChoice(OFF)
    removeOnline()
  }, [titleKey, removeOnline, setChoice])

  // The video's own, once its media is in (and as more are found). Off stays
  // off: hls.js would show a stream's DEFAULT subtitles by itself.
  useEffect(() => {
    if (!ready) return
    const v = videoRef.current
    const hls = hlsRef.current
    const read = () => {
      if (hls) {
        setEmbedded((hls.subtitleTracks || []).map((t, i) => ({ id: i, label: t.name || '', language: t.lang || '' })))
        if (choiceRef.current.kind !== 'embedded' && hls.subtitleTrack !== -1) hls.subtitleTrack = -1
      } else if (v) {
        const tracks = [...v.textTracks]
        setEmbedded(tracks
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => (t.kind === 'subtitles' || t.kind === 'captions') && t.label !== ONLINE_LABEL)
          .map(({ t, i }) => ({ id: i, label: t.label || '', language: t.language || '' })))
        if (choiceRef.current.kind !== 'embedded') tracks.forEach((t) => { if (t.label !== ONLINE_LABEL && t.mode === 'showing') t.mode = 'disabled' })
      }
      setEmbeddedFor(titleKey)
    }
    read()
    if (hls && events) { hls.on(events.SUBTITLE_TRACKS_UPDATED, read); hls.on(events.SUBTITLE_TRACK_SWITCH, read) }
    v?.textTracks?.addEventListener?.('addtrack', read)
    return () => {
      if (hls && events) { hls.off(events.SUBTITLE_TRACKS_UPDATED, read); hls.off(events.SUBTITLE_TRACK_SWITCH, read) }
      v?.textTracks?.removeEventListener?.('addtrack', read)
    }
  }, [ready, titleKey, videoRef, hlsRef, events])

  /** The online list for this title: asked once — again after it failed. */
  const loadOnline = useCallback(() => {
    if (online.for === titleKey && (online.loading || !online.error)) return
    const key = titleKey
    setOnline({ ...NO_ONLINE, for: key, loading: true })
    getVodSubtitles(queryRef.current)
      .then((r) => setOnline((o) => (o.for === key ? { for: key, loading: false, configured: !!r.configured, provider: r.provider || '', results: r.results || [], error: r.error || '' } : o)))
      .catch((e) => setOnline((o) => (o.for === key ? { for: key, loading: false, configured: true, provider: '', results: [], error: e.message } : o)))
  }, [online.for, online.loading, online.error, titleKey])

  // Showing one: the others off. An online file that won't load is let go,
  // and the menu says so.
  const apply = useCallback((kind, id, language, d) => {
    const v = videoRef.current
    const hls = hlsRef.current
    if (!v) return
    removeOnline()
    if (hls) {
      hls.subtitleDisplay = kind === 'embedded'
      hls.subtitleTrack = kind === 'embedded' ? id : -1
    } else {
      [...v.textTracks].forEach((t, i) => { if (t.label !== ONLINE_LABEL) t.mode = kind === 'embedded' && i === id ? 'showing' : 'disabled' })
    }
    if (kind === 'online') {
      const el = document.createElement('track')
      el.kind = 'subtitles'
      el.label = ONLINE_LABEL
      el.srclang = language || 'en'
      el.src = subtitleFileUrl(id, d)
      el.addEventListener('error', () => {
        if (trackRef.current !== el) return
        removeOnline()
        setChoice(OFF)
        setOnline((o) => ({ ...o, error: "That subtitle couldn't be loaded — try another." }))
      })
      v.appendChild(el)
      el.track.mode = 'showing'
      trackRef.current = el
    }
  }, [videoRef, hlsRef, removeOnline, setChoice])

  /** A viewer's pick — kept for the next title, and not undone by the one made to start with. */
  const pick = useCallback((kind, id = null, language = '') => {
    startedRef.current = titleKey
    apply(kind, id, language, delay)
    setChoice({ kind, id, language })
    saveChoice(kind, kind === 'off' ? '' : language)
  }, [apply, delay, titleKey, setChoice])

  // The delay shows at once; the file moved by it is fetched once the presses stop.
  const delayTimer = useRef(null)
  const setDelay = useCallback((d) => {
    const next = clampDelay(d)
    setDelayState(next)
    saveDelay(next)
    clearTimeout(delayTimer.current)
    delayTimer.current = setTimeout(() => {
      const c = choiceRef.current
      if (c.kind === 'online') apply('online', c.id, c.language, next)
    }, DELAY_SETTLE_MS)
  }, [apply])
  useEffect(() => () => clearTimeout(delayTimer.current), [])

  // Each title starts with the language picked last — the video's own, once
  // they've been read, else online (asked for only then); off made sure of.
  useEffect(() => {
    if (!ready || startedRef.current === titleKey || embeddedFor !== titleKey) return
    const saved = savedChoice()
    if (saved.kind === 'off') { startedRef.current = titleKey; apply('off'); return }
    const now = startingChoice(saved, embedded, [])
    if (now) { startedRef.current = titleKey; apply(now.kind, now.id, saved.language, delay); setChoice({ ...now, language: saved.language }); return }
    // No language to look for online (a track picked without one): nothing online could match.
    if (!saved.language) { startedRef.current = titleKey; apply('off'); return }
    if (online.for !== titleKey) { loadOnline(); return }
    if (online.loading) return
    startedRef.current = titleKey
    const fetched = startingChoice(saved, [], online.results)
    if (fetched) { apply(fetched.kind, fetched.id, saved.language, delay); setChoice({ ...fetched, language: saved.language }) } else apply('off')
  }, [ready, titleKey, embedded, embeddedFor, online, loadOnline, apply, delay, setChoice])

  // Leaving the player: the <track> goes with it.
  useEffect(() => removeOnline, [removeOnline])

  return { embedded, online, choice, delay, pick, setDelay, loadOnline }
}
