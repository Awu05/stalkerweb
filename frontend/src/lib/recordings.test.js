import { describe, it, expect } from 'vitest'
import { groupRecordings, recordingLabel, endForChoice, RECORD_CHOICES } from './recordings'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 31, 18, 0)   // Sat 31 Oct, 18:00 UTC
const rec = (o) => ({ id: o.id, channelName: 'News 24', title: 'Evening News', bytes: 0, createdAt: NOW, ...o })

describe('groupRecordings', () => {
  it('splits into scheduled (soonest first), recording, and done (newest first) — cancelled left out', () => {
    const list = [
      rec({ id: 'a', status: 'scheduled', startAt: NOW + 120 * MIN, endAt: NOW + 180 * MIN }),
      rec({ id: 'b', status: 'scheduled', startAt: NOW + 60 * MIN, endAt: NOW + 90 * MIN }),
      rec({ id: 'c', status: 'recording', startAt: NOW - 10 * MIN, endAt: null }),
      rec({ id: 'd', status: 'done', startAt: NOW - 300 * MIN, endAt: NOW - 240 * MIN }),
      rec({ id: 'e', status: 'failed', startAt: NOW - 100 * MIN, endAt: NOW - 50 * MIN }),
      rec({ id: 'f', status: 'missed', startAt: NOW - 600 * MIN, endAt: NOW - 500 * MIN }),
      rec({ id: 'g', status: 'cancelled', startAt: NOW, endAt: NOW + MIN }),
    ]
    const g = groupRecordings(list, NOW)
    expect(g.scheduled.map((r) => r.id)).toEqual(['b', 'a'])
    expect(g.recording.map((r) => r.id)).toEqual(['c'])
    expect(g.done.map((r) => r.id)).toEqual(['e', 'd', 'f'])
  })
})

describe('recordingLabel', () => {
  const o = { now: NOW, timeZone: 'UTC' }
  it('a booked one: when it records', () => {
    expect(recordingLabel(rec({ status: 'scheduled', startAt: NOW + 120 * MIN, endAt: NOW + 185 * MIN }), o)).toBe('Today 20:00–21:05')
    expect(recordingLabel(rec({ status: 'scheduled', startAt: NOW + 26 * 60 * MIN, endAt: NOW + 27 * 60 * MIN }), o)).toBe('Tomorrow 20:00–21:00')
    expect(recordingLabel(rec({ status: 'scheduled', startAt: NOW + 3 * 1440 * MIN, endAt: NOW + 3 * 1440 * MIN + 30 * MIN }), o)).toBe('Tue 3 Nov 18:00–18:30')
  })
  it('one recording now: how long, and how big so far', () => {
    expect(recordingLabel(rec({ status: 'recording', startAt: NOW - 12 * MIN, endAt: null, bytes: 340 * 1024 ** 2 }), o)).toBe('Recording · 12 min · 340 MB')
  })
  it('a finished one: when, how long, how big', () => {
    expect(recordingLabel(rec({ status: 'done', startAt: NOW - 1440 * MIN, endAt: NOW - 1440 * MIN + 65 * MIN, bytes: 2.1 * 1024 ** 3 }), o)).toBe('Recorded 30 Oct · 1 h 05 · 2.1 GB')
  })
  it('one stopped early shows how long it really ran', () => {
    expect(recordingLabel(rec({ status: 'done', startAt: NOW - 120 * MIN, endAt: NOW + 60 * MIN, endedAt: NOW - 100 * MIN, bytes: 200 * 1024 ** 2 }), o)).toBe('Recorded 31 Oct · 20 min · 200 MB')
  })
  it('failed and missed say why', () => {
    expect(recordingLabel(rec({ status: 'failed', startAt: NOW, endAt: NOW, error: 'Less than 1 GB free on the disk — the recording didn\'t start.' }), o)).toBe('Failed — Less than 1 GB free on the disk — the recording didn\'t start.')
    expect(recordingLabel(rec({ status: 'missed', startAt: NOW, endAt: NOW }), o)).toBe('Missed — the server wasn\'t running')
  })
})

describe('endForChoice', () => {
  it('until the programme ends (an hour when the guide has no end), a set time, or until stopped', () => {
    expect(RECORD_CHOICES.map((c) => c.id)).toEqual(['programme', '30', '60', '120', 'stop'])
    expect(endForChoice('programme', NOW, NOW + 25 * MIN)).toBe(NOW + 25 * MIN)
    expect(endForChoice('programme', NOW, null)).toBe(NOW + 60 * MIN)
    expect(endForChoice('30', NOW)).toBe(NOW + 30 * MIN)
    expect(endForChoice('120', NOW)).toBe(NOW + 120 * MIN)
    expect(endForChoice('stop', NOW)).toBeNull()
  })
})
