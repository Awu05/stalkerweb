/**
 * The movie & series player's audio tracks (components/PlayerSettingsMenu.jsx,
 * lib/useVodAudio.js): their names, and the one in the viewer's preferred
 * language. The apps' AudioTracks.kt says the same.
 */
import { baseLanguage, languageName } from './subtitles'

// The preferred-language choices, as ISO 639-1 codes (stored per viewer).
const LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ar', 'tr', 'hi', 'zh', 'ja', 'ko', 'nl', 'pl', 'sv', 'el', 'he', 'fa', 'ro', 'uk',
  'cs', 'da', 'fi', 'hu', 'no', 'bg', 'hr', 'sr', 'sk', 'th', 'vi', 'id', 'ms', 'bn', 'ur', 'ta', 'te', 'pa',
]

/** "Stream default", then the languages by name: [{ code, name }]. */
export function audioLanguageOptions() {
  const named = LANGUAGES.map((code) => ({ code, name: languageName(code) }))
  named.sort((a, b) => a.name.localeCompare(b.name))
  return [{ code: '', name: 'Stream default' }, ...named]
}

// A language a track can be matched by: "und" (undetermined) and "mul" aren't.
const known = (code) => {
  const c = baseLanguage(code)
  return c && c !== 'und' && c !== 'mul' && c !== 'zxx' ? c : ''
}

/** Whether two language codes are one language: "eng" = "en" = "en-US". */
export function sameLanguage(a, b) {
  const x = known(a)
  return !!x && x === known(b)
}

/** A channel count as people say it: "6" → "5.1", 2 → "Stereo". */
export function channelsLabel(channels) {
  const n = parseInt(String(channels ?? '').split('/')[0], 10)
  if (!n) return ''
  return { 1: 'Mono', 2: 'Stereo', 6: '5.1', 7: '6.1', 8: '7.1' }[n] ?? `${n} channels`
}

/**
 * Each track [{ id, lang, name, channels }] with a `label`: its language, and
 * where two share one, what tells them apart ("English · 5.1").
 */
export function audioTrackLabels(tracks) {
  const list = tracks || []
  const count = new Map()
  for (const t of list) { const l = known(t.lang); if (l) count.set(l, (count.get(l) ?? 0) + 1) }
  return list.map((t, i) => {
    const l = known(t.lang)
    if (!l) return { ...t, label: t.name || `Audio ${i + 1}` }
    const lang = languageName(l)
    if (count.get(l) < 2) return { ...t, label: lang }
    const name = t.name && t.name.toLowerCase() !== lang.toLowerCase() && known(t.name) !== l ? t.name : ''
    return { ...t, label: `${lang} · ${name || channelsLabel(t.channels) || `Track ${i + 1}`}` }
  })
}

/** The id of the first track in `language` (two letters), or null — then the stream's own plays. */
export function preferredAudioTrack(tracks, language) {
  if (!language) return null
  return (tracks || []).find((t) => sameLanguage(t.lang, language))?.id ?? null
}
