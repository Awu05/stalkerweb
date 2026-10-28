/**
 * The time zones a connection can use (the portal's `timezone`), for the
 * searchable picker (components/TimezonePicker.jsx): the list in
 * shared/timezones.json — the same one the apps offer (Timezones.kt), by the
 * zones' current names — each with its country and its UTC offset now.
 */
import { ZONES } from './timezones.generated'

// For matching: lower case, no accents, "_" and "/" as spaces.
const ACCENTS = new RegExp('[\\u0300-\\u036f]', 'g')
const plain = (s) => String(s || '').normalize('NFD').replace(ACCENTS, '').toLowerCase().replace(/[_/]+/g, ' ').trim()

/** Whether the browser knows a time zone by this name (one not in the list can still be used). */
export function isZone(name) {
  if (!name || typeof name !== 'string') return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true } catch { return false }
}

/** A zone's UTC offset at a moment, in minutes (east +); null for one the browser doesn't know. */
export function offsetMinutes(zone, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || ''
    if (name === 'GMT' || name === 'UTC') return 0
    const m = /^GMT([+\-−])(\d{1,2})(?::?(\d{2}))?$/.exec(name)
    if (!m) return null
    const mins = Number(m[2]) * 60 + Number(m[3] || 0)
    return m[1] === '+' ? mins : -mins
  } catch {
    return null
  }
}

/** 330 → "UTC+05:30", −300 → "UTC−05:00", 0 → "UTC", null → "". */
export function offsetLabel(mins) {
  if (mins === null || mins === undefined) return ''
  if (mins === 0) return 'UTC'
  const a = Math.abs(mins)
  return `UTC${mins > 0 ? '+' : '−'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

/** A zone's UTC offset now, as "UTC+01:00" ('' for one the browser doesn't know). */
export const utcOffset = (zone, at = new Date()) => offsetLabel(offsetMinutes(zone, at))

/**
 * A search that's an offset — "UTC+1", "+1", "-5", "gmt+5:30", "+0530",
 * "UTC" — as minutes east of UTC; null for any other search.
 */
export function parseOffset(query) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '').replace(/−/g, '-')
  if (q === 'utc' || q === 'gmt' || q === 'z') return 0
  const m = /^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(q)
  if (!m) return null
  const hours = Number(m[2])
  const minutes = Number(m[3] || 0)
  if (hours > 14 || minutes > 59) return null
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

let regionNames = null
function countryName(cc) {
  if (!cc) return ''
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regionNames.of(cc) || ''
  } catch {
    return ''
  }
}

/**
 * The list as the picker shows and searches it: { id, country, offset
 * (minutes), label ("UTC+01:00"), words (what a search is matched against) }
 * — `current` added if it isn't in it (a zone saved before, or typed in).
 * The offsets are worked out once and kept for a while (they change at
 * daylight saving).
 */
let kept = null
export function zoneEntries(current = '', now = new Date()) {
  if (!kept || now - kept.at > 60 * 60 * 1000) {
    kept = {
      at: now,
      list: ZONES.map(([id, cc]) => {
        const offset = offsetMinutes(id, now)
        const country = countryName(cc)
        return { id, country, offset, label: offsetLabel(offset), words: plain(`${id} ${country}`), countryWords: plain(country) }
      }),
    }
  }
  if (!current || kept.list.some((z) => z.id === current)) return kept.list
  const offset = offsetMinutes(current, now)
  return [{ id: current, country: '', offset, label: offsetLabel(offset), words: plain(current) }, ...kept.list]
}

/**
 * The zones matching a search, best first. An offset ("UTC+1", "-5",
 * "+05:30") matches the zones at that offset now. Anything else: every word
 * in the zone's name or country, the ones whose city is it — or starts with
 * it — and its country by that name, ahead. An empty search keeps them all, in order.
 */
export function filterZones(entries, query) {
  const off = parseOffset(query)
  if (off !== null) return entries.filter((z) => z.offset === off)
  const words = plain(query).split(/\s+/).filter(Boolean)
  if (!words.length) return entries
  const q = words.join(' ')
  const scored = []
  for (const z of entries) {
    if (!words.every((w) => z.words.includes(w))) continue
    const city = plain(z.id.split('/').pop())
    const score = city === q || z.countryWords === q ? 0 : city.startsWith(q) ? 1 : z.words.split(' ').some((p) => p.startsWith(words[0])) ? 2 : 3
    scored.push([score, z])
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].id.localeCompare(b[1].id)).map(([, z]) => z)
}
