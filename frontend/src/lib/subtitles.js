/**
 * The VOD player's subtitles (components/SubtitleMenu.jsx): the ones in the
 * video, and online ones through the server (backend lib/subtitles.js).
 * The apps' Subtitles.kt says the same.
 */

const DELAY_KEY = 'vodSubtitleDelay'
const CHOICE_KEY = 'vodSubtitles'
export const DELAY_STEP = 0.5
export const MAX_DELAY = 60

// Videos name their tracks' languages in three letters ("eng", "spa"),
// the online sites in two ("en", "es"): the common ones, matched up.
const TWO_LETTER = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl',
  rus: 'ru', ara: 'ar', chi: 'zh', zho: 'zh', jpn: 'ja', kor: 'ko', tur: 'tr', pol: 'pl', swe: 'sv', nor: 'no',
  dan: 'da', fin: 'fi', gre: 'el', ell: 'el', heb: 'he', hin: 'hi', rum: 'ro', ron: 'ro', hun: 'hu', cze: 'cs', ces: 'cs',
  per: 'fa', fas: 'fa', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', slo: 'sk', slk: 'sk', slv: 'sl', tha: 'th', vie: 'vi',
  ind: 'id', may: 'ms', msa: 'ms', ben: 'bn', urd: 'ur', tam: 'ta', tel: 'te', pan: 'pa', cat: 'ca', alb: 'sq', sqi: 'sq',
  nob: 'no', nno: 'no',
}

/** A language code as two letters where it can be: "eng" → "en", "pt-BR" → "pt". */
export function baseLanguage(code) {
  const c = String(code || '').trim().toLowerCase().split(/[-_]/)[0]
  return TWO_LETTER[c] ?? c
}

/** "en" → "English", "pt-br" → "Portuguese (Brazil)"; an unknown code as it is. */
export function languageName(code) {
  const c = String(code || '').trim()
  if (!c) return 'Unknown language'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(c) || c
  } catch {
    return c
  }
}

/** The online subtitles by language, in order: [{ language, name, items }]. */
export function byLanguage(results) {
  const groups = new Map()
  for (const r of results || []) {
    const key = r.language || ''
    if (!groups.has(key)) groups.set(key, { language: key, name: languageName(key), items: [] })
    groups.get(key).items.push(r)
  }
  return [...groups.values()]
}

/** What a viewer picked, kept for the next episode or film: { kind: 'off' | 'embedded' | 'online', language }. */
export function savedChoice() {
  try {
    const c = JSON.parse(localStorage.getItem(CHOICE_KEY) || 'null')
    return c && ['off', 'embedded', 'online'].includes(c.kind) ? { kind: c.kind, language: String(c.language || '') } : { kind: 'off', language: '' }
  } catch {
    return { kind: 'off', language: '' }
  }
}

export function saveChoice(kind, language = '') {
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify({ kind, language })) } catch { /* private mode */ }
}

/**
 * The subtitles to start a title with, from what was picked last: the video's
 * own in that language (or its first), else the online ones' most downloaded
 * in it. `embedded` [{ id, language }], `online` the server's results.
 */
export function startingChoice(saved, embedded, online) {
  if (!saved || saved.kind === 'off') return null
  const lang = baseLanguage(saved.language)
  const sameLang = (l) => !!lang && baseLanguage(l) === lang
  const inVideo = embedded.find((t) => sameLang(t.language)) ?? (saved.kind === 'embedded' && !lang ? embedded[0] : null)
  if (inVideo) return { kind: 'embedded', id: inVideo.id }
  const fetched = (online || []).find((r) => sameLang(r.language) && !r.machine) ?? (online || []).find((r) => sameLang(r.language))
  if (fetched) return { kind: 'online', id: fetched.fileId }
  return null
}

/** The subtitle delay, kept on this browser: seconds, + later. */
export function savedDelay() {
  try { return clampDelay(Number(localStorage.getItem(DELAY_KEY)) || 0) } catch { return 0 }
}

export function saveDelay(d) {
  try { localStorage.setItem(DELAY_KEY, String(d)) } catch { /* private mode */ }
}

export function clampDelay(d) {
  const n = Math.round((Number(d) || 0) / DELAY_STEP) * DELAY_STEP
  return Math.max(-MAX_DELAY, Math.min(MAX_DELAY, n))
}

/** "+1.5 s", "−0.5 s", "0 s". */
export function delayLabel(d) {
  if (!d) return '0 s'
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} s`
}

/** The server's link to an online subtitle file, with the delay. */
export function subtitleFileUrl(fileId, delay = 0) {
  return `/api/vod/subtitles/file/${encodeURIComponent(fileId)}.vtt${delay ? `?offset=${delay}` : ''}`
}
