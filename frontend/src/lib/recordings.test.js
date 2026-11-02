import { describe, it, expect } from 'vitest'
import { groupRecordings, recordingLabel, endForChoice, RECORD_CHOICES, stillRecording } from './recordings'

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
    const g = groupRecordings(list)
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

describe('recording positions (resume, on this device)', () => {
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
  it('keeps where a recording was left, and forgets it once it is near the end', async () => {
    const { loadRecordingPosition, saveRecordingPosition } = await import('./recordings')
    const s = store()
    expect(loadRecordingPosition('r1', s)).toBeNull()
    saveRecordingPosition('r1', 600, 3600, s)
    expect(loadRecordingPosition('r1', s)).toEqual({ position: 600 })
    saveRecordingPosition('r1', 3500, 3600, s)   // past 95%: finished
    expect(loadRecordingPosition('r1', s)).toBeNull()
  })
  it('never throws when storage is unavailable', async () => {
    const { loadRecordingPosition, saveRecordingPosition } = await import('./recordings')
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    expect(loadRecordingPosition('r1', broken)).toBeNull()
    expect(() => saveRecordingPosition('r1', 10, 100, broken)).not.toThrow()
  })
})

describe('stillRecording', () => {
  it('is true only while the recording is listed as recording', () => {
    const list = [rec({ id: 'a', status: 'recording', startAt: NOW }), rec({ id: 'b', status: 'done', startAt: NOW }), rec({ id: 'c', status: 'failed', startAt: NOW })]
    expect(stillRecording(list, 'a')).toBe(true)
    expect(stillRecording(list, 'b')).toBe(false)   // ended by itself, or stopped elsewhere
    expect(stillRecording(list, 'c')).toBe(false)
    expect(stillRecording(list, 'gone')).toBe(false)   // deleted
    expect(stillRecording(null, 'a')).toBe(false)
  })
})

describe('who stopped or cancelled it', () => {
  const o = { now: NOW, timeZone: 'UTC' }
  it("says who stopped someone else's recording, or cancelled their booking", () => {
    expect(recordingLabel(rec({ status: 'done', startAt: NOW - 120 * MIN, endAt: NOW + 60 * MIN, endedAt: NOW - 100 * MIN, bytes: 200 * 1024 ** 2, stoppedBy: 'Bea' }), o))
      .toBe('Recorded 31 Oct · 20 min · 200 MB · Stopped by Bea')
    expect(recordingLabel(rec({ status: 'cancelled', startAt: NOW, endAt: NOW + MIN, stoppedBy: 'Bea' }), o)).toBe('Cancelled by Bea')
  })
  it('a booking someone else cancelled is listed with the recorded ones, so its owner sees it; one cancelled by its owner is not', () => {
    const g = groupRecordings([
      rec({ id: 'a', status: 'cancelled', startAt: NOW, endAt: NOW + MIN, stoppedBy: 'Bea' }),
      rec({ id: 'b', status: 'cancelled', startAt: NOW, endAt: NOW + MIN }),
    ])
    expect(g.done.map((r) => r.id)).toEqual(['a'])
  })
})

describe('keepRecordingsResult', () => {
  it("keeps a list only when it was asked for in the mode the switch is in now", async () => {
    const { keepRecordingsResult } = await import('./recordings')
    expect(keepRecordingsResult(true, true)).toBe(true)
    expect(keepRecordingsResult(false, false)).toBe(true)
    expect(keepRecordingsResult(false, true)).toBe(false)   // asked before the switch went on: dropped
    expect(keepRecordingsResult(true, false)).toBe(false)
  })
})

describe('the server decides who may delete', () => {
  it('there is no canDelete of its own here (the list says canDelete)', async () => {
    const lib = await import('./recordings')
    expect(lib.canDelete).toBeUndefined()
  })
})
