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

/** The lengths offered: "until the programme ends" only with a guide end still to come. */
export function recordChoices(programmeEnd, now) {
  return programmeEnd && programmeEnd > now ? RECORD_CHOICES : RECORD_CHOICES.filter((c) => c.id !== 'programme')
}

/** When a recording started now ends: ms, or null for "until stopped". No guide end: an hour. */
export function endForChoice(choice, now, programmeEnd = null) {
  if (choice === 'stop') return null
  if (choice === 'programme') return programmeEnd && programmeEnd > now ? programmeEnd : now + 60 * MIN
  return now + (parseInt(choice, 10) || 60) * MIN
}

/**
 * The id of the recording being made on `channelId`, in the list from GET
 * /api/recordings — started in this player, on another device or from the
 * guide — or null. The player's Record button follows it.
 */
export function recordingOn(list, channelId) {
  return list?.find((r) => r.status === 'recording' && String(r.channelId) === String(channelId))?.id ?? null
}

/**
 * { scheduled (soonest first), recording, done (newest first — failed and
 * missed too) }. Cancelled ones aren't shown — unless someone else cancelled
 * it (stoppedBy), so its owner sees who.
 */
export function groupRecordings(list) {
  const by = (s) => list.filter((r) => s.includes(r.status))
  return {
    scheduled: by(['scheduled']).sort((a, b) => a.startAt - b.startAt),
    recording: by(['recording']),
    done: list.filter((r) => ['done', 'failed', 'missed'].includes(r.status) || (r.status === 'cancelled' && r.stoppedBy))
      .sort((a, b) => b.startAt - a.startAt),
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

/** The Recordings page's disk line, from GET /api/recordings' `disk` (freeBytes null: unknown). */
export function diskLine(disk) {
  if (!disk) return ''
  const free = disk.freeBytes == null ? null : `${size(disk.freeBytes)} free`
  if (!disk.usedBytes) return free ? `${free} for recordings` : ''
  return [`Recordings use ${size(disk.usedBytes)}`, free].filter(Boolean).join(' · ')
}

function length(ms) {
  const m = Math.max(0, Math.round(ms / MIN))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** How a recording was started (GET /api/recordings' `source`), for its label: Manual or Scheduled. */
export function sourceLabel(r) {
  return r.source === 'manual' ? 'Manual' : r.source === 'scheduled' ? 'Scheduled' : ''
}

/** The line under a recording's title. `timeZone`: for tests; else the browser's. */
export function recordingLabel(r, { now = Date.now(), timeZone } = {}) {
  const o = { now, timeZone }
  // A booked one says how long it was booked for (with its padding): bookedMs — a part 2, after a
  // restart, keeps its part 1's — or, from an older server, its own start to end.
  const bookedMs = r.source === 'scheduled' ? (r.bookedMs ?? (r.endAt ? r.endAt - r.startAt : null)) : null
  const booked = bookedMs ? length(bookedMs) : null
  const of = booked ? ` of ${booked}` : ''
  switch (r.status) {
    case 'scheduled':
      return `${dayLabel(r.startAt, o)} ${time(r.startAt, timeZone)}${r.endAt ? `–${time(r.endAt, timeZone)}` : ''}${booked ? ` · ${booked}` : ''}`
    case 'recording':
      return `Recording · ${length(now - r.startAt)}${of} · ${size(r.bytes || 0)}`
    case 'done':
      return `Recorded ${shortDate(r.startAt, timeZone)} · ${length((r.endedAt ?? r.endAt ?? now) - r.startAt)}${of} · ${size(r.bytes || 0)}${r.stoppedBy ? ` · Stopped by ${r.stoppedBy}` : ''}`
    case 'failed':
      return `Failed — ${r.error || 'the recording didn\'t work'}`
    case 'missed':
      return 'Missed — the server wasn\'t running'
    case 'cancelled':
      return r.stoppedBy ? `Cancelled by ${r.stoppedBy}` : 'Cancelled'
    default:
      return ''
  }
}

// Where a recording was left — kept on this device, not in the server's
// Continue Watching (a recording isn't a VOD title). Gone once near the end.
const POS_KEY = (id) => `sw:recording-position:${id}`
const DONE_FRACTION = 0.95
const browserStorage = () => { try { return globalThis.localStorage ?? null } catch { return null } }

/** { position } (seconds), or null. */
export function loadRecordingPosition(id, storage = browserStorage()) {
  try {
    const n = Number(storage?.getItem(POS_KEY(id)))
    return Number.isFinite(n) && n > 0 ? { position: n } : null
  } catch { return null }
}

export function saveRecordingPosition(id, position, duration, storage = browserStorage()) {
  try {
    if (!storage || !(duration > 0)) return
    if (position >= duration * DONE_FRACTION) storage.removeItem(POS_KEY(id))
    else storage.setItem(POS_KEY(id), String(Math.floor(position)))
  } catch { /* storage refused: no resume, nothing else lost */ }
}

/**
 * Whether a list asked for with Everyone's recordings [asked] may be shown now
 * the switch is [current]: one asked for before it changed is dropped, so it
 * never overwrites the other mode's. (Who may delete one is the server's
 * word: each row's canDelete.)
 */
export function keepRecordingsResult(asked, current) {
  return asked === current
}

// ── Record a time ─────────────────────────────────────────────────────────────
// Where the guide has no programme to book (a channel without guide data, or
// a "No information available" stand-in): a start and an end of your own.
// Booked like a programme (POST /api/recordings), so the padding, the stream
// limit and the clash check are the same. RecordingRules.kt says the same.

/** The lengths offered, in minutes. */
export const RECORD_LENGTHS = [30, 60, 120, 180]
const MAX_TIMED_MS = 12 * 60 * MIN

/** A guide entry that stands for no programme ("No information available"): recorded by time instead. */
export function isGuidePlaceholder(title) {
  const t = String(title ?? '').trim()
  return !t || /^no (information|info|data|programme|program|epg|guide)\b/i.test(t)
}

// The local half hour `ms` is in.
function halfHour(ms) {
  const d = new Date(ms)
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0)
  return d.getTime()
}

/** Where Record a time starts: the half hour `at` is in — or, that one over, the half hour now is in. */
export function timedStart(at, now) {
  const s = halfHour(at)
  return s + 30 * MIN <= now ? halfHour(now) : s
}

/** The end for an "HH:MM" picked after `startAt`: that time on its day, or the next day when it's not later. */
export function endAtTime(startAt, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  const d = new Date(startAt)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= startAt) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** What Record a time books — { title, startAt, endAt } — or { error } saying why it can't. */
export function timedBooking({ startAt, endAt, title, channelName, now }) {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return { error: 'Pick when it starts and ends.' }
  if (endAt <= startAt) return { error: 'It has to end after it starts.' }
  if (endAt <= now) return { error: 'That time has already passed.' }
  if (endAt - startAt > MAX_TIMED_MS) return { error: 'A recording can be at most 12 hours.' }
  return { title: String(title ?? '').trim() || channelName || 'Recording', startAt, endAt }
}
