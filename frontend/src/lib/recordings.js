// Live TV recordings (the server's recordings/): the Recordings page's
// groups and lines, and when a "Record now" ends. The apps'
// RecordingRules.kt says the same.

const MIN = 60_000

/** What "Record now" offers, in order. */
export const RECORD_CHOICES = [
  { id: 'programme', label: 'Until the programme ends' },
  { id: '30', label: '30 minutes' },
  { id: '60', label: '1 hour' },
  { id: '120', label: '2 hours' },
  { id: 'stop', label: 'Until I stop it' },
]

/** When a recording started now ends: ms, or null for "until stopped". No guide end: an hour. */
export function endForChoice(choice, now, programmeEnd = null) {
  if (choice === 'stop') return null
  if (choice === 'programme') return programmeEnd && programmeEnd > now ? programmeEnd : now + 60 * MIN
  return now + (parseInt(choice, 10) || 60) * MIN
}

/** { scheduled (soonest first), recording, done (newest first — failed and missed too) }; cancelled ones aren't shown. */
export function groupRecordings(list, now = Date.now()) {
  const by = (s) => list.filter((r) => s.includes(r.status))
  return {
    scheduled: by(['scheduled']).sort((a, b) => a.startAt - b.startAt),
    recording: by(['recording']),
    done: by(['done', 'failed', 'missed']).sort((a, b) => b.startAt - a.startAt),
  }
}

const parts = (ms, timeZone, o) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, ...o }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
const time = (ms, timeZone) => { const p = parts(ms, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); return `${p.hour}:${p.minute}` }
const dayKey = (ms, timeZone) => { const p = parts(ms, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${p.year}-${p.month}-${p.day}` }
const shortDate = (ms, timeZone) => { const p = parts(ms, timeZone, { day: 'numeric', month: 'short' }); return `${p.day} ${p.month}` }

function dayLabel(ms, { now, timeZone }) {
  if (dayKey(ms, timeZone) === dayKey(now, timeZone)) return 'Today'
  if (dayKey(ms, timeZone) === dayKey(now + 1440 * MIN, timeZone)) return 'Tomorrow'
  return `${parts(ms, timeZone, { weekday: 'short' }).weekday} ${shortDate(ms, timeZone)}`
}

function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`
}

function length(ms) {
  const m = Math.max(0, Math.round(ms / MIN))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** The line under a recording's title. `timeZone`: for tests; else the browser's. */
export function recordingLabel(r, { now = Date.now(), timeZone } = {}) {
  const o = { now, timeZone }
  switch (r.status) {
    case 'scheduled':
      return `${dayLabel(r.startAt, o)} ${time(r.startAt, timeZone)}${r.endAt ? `–${time(r.endAt, timeZone)}` : ''}`
    case 'recording':
      return `Recording · ${length(now - r.startAt)} · ${size(r.bytes || 0)}`
    case 'done':
      return `Recorded ${shortDate(r.startAt, timeZone)} · ${length((r.endedAt ?? r.endAt ?? now) - r.startAt)} · ${size(r.bytes || 0)}`
    case 'failed':
      return `Failed — ${r.error || 'the recording didn\'t work'}`
    case 'missed':
      return 'Missed — the server wasn\'t running'
    default:
      return ''
  }
}
