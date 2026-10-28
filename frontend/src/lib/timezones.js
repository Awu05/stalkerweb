/**
 * The time zones a connection can use (the portal's `timezone`), for the
 * searchable picker (components/TimezonePicker.jsx). The apps' Timezones.kt
 * does the same from Java's list.
 */

// A browser without Intl.supportedValuesOf gets the commonest ones.
const FALLBACK = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Istanbul',
  'Europe/Moscow', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Manila', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'America/Mexico_City', 'America/Bogota', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Halifax',
]

/** Every IANA time zone the browser knows ("Europe/London"…), with UTC; `current` too if it isn't one. */
export function allTimezones(current = '') {
  let list
  try { list = Intl.supportedValuesOf('timeZone') } catch { list = FALLBACK }
  const set = new Set(list.length ? list : FALLBACK)
  set.add('UTC')
  if (current) set.add(current)
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** A zone's UTC offset now: "UTC+01:00", "UTC−05:00", "UTC" — '' for one the browser doesn't know. */
export function utcOffset(zone, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || ''
    if (name === 'GMT') return 'UTC'
    const m = /^GMT([+-−])(\d{1,2})(?::?(\d{2}))?$/.exec(name)
    if (!m) return ''
    if (Number(m[2]) === 0 && Number(m[3] || 0) === 0) return 'UTC'
    return `UTC${m[1] === '+' ? '+' : '−'}${m[2].padStart(2, '0')}:${m[3] || '00'}`
  } catch {
    return ''
  }
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires, Argentina, America" — the words people search by. */
export function zoneWords(zone) {
  return zone.split('/').reverse().map((p) => p.replace(/_/g, ' ')).join(', ')
}

// For matching: lower case, no accents, "_" and "/" as spaces.
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[_/]+/g, ' ').trim()

/**
 * The zones matching a search, best first: every word of it in the zone's
 * name or its UTC offset, the ones whose city starts with it ahead. An empty
 * search keeps them all, in order.
 */
export function filterTimezones(zones, query, offsetOf = utcOffset) {
  const words = plain(query).split(/\s+/).filter(Boolean)
  if (!words.length) return zones
  const scored = []
  for (const z of zones) {
    const name = plain(z)
    const offset = plain(offsetOf(z)).replace(/−/g, '-')
    const hay = `${name} ${offset}`
    if (!words.every((w) => hay.includes(w.replace(/−/g, '-')))) continue
    const city = plain(z.split('/').pop())
    const q = words.join(' ')
    const score = city === q ? 0 : city.startsWith(q) ? 1 : name.split(' ').some((p) => p.startsWith(words[0])) ? 2 : 3
    scored.push([score, z])
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).map(([, z]) => z)
}
