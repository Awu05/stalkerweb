import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import RecordingStore from '../recordings/RecordingStore.js'
import { sourceOf } from '../recordings/RecordingStore.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 31, 20, 0)   // a programme from 20:00 to 21:00
let dir, now, store
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rec-'))
  now = T0 - 60 * MIN
  store = new RecordingStore(dir, { now: () => now })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const book = (o = {}) => store.schedule({
  viewerId: 'view_a', channelId: '7', channelName: 'News 24', title: 'Evening News',
  startAt: T0, endAt: T0 + 60 * MIN, padBeforeMin: 2, padAfterMin: 5, ...o,
})

describe('RecordingStore', () => {
  it('schedules with padding applied', () => {
    const r = book()
    expect(r).toMatchObject({ status: 'scheduled', channelId: '7', title: 'Evening News', viewerId: 'view_a', bytes: 0 })
    expect(r.startAt).toBe(T0 - 2 * MIN)
    expect(r.endAt).toBe(T0 + 65 * MIN)
    expect(typeof r.id).toBe('string')
    expect(r.source).toBe('scheduled')
    expect(book({ source: 'manual' }).source).toBe('manual')
  })

  it('fills in how older ones were started and how long they were booked for; a part 2 from its part 1', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rec-legacy-'))
    fs.writeFileSync(path.join(d, 'recordings.json'), JSON.stringify([
      { id: 'a', startAt: T0, endAt: T0 + 67 * MIN, createdAt: T0 - 60 * MIN, status: 'done', bytes: 5 },
      { id: 'b', startAt: T0 + 40 * MIN, endAt: T0 + 67 * MIN, createdAt: T0 + 40 * MIN, status: 'done', partOf: 'a', bytes: 7 },
      { id: 'c', startAt: T0, endAt: null, createdAt: T0, status: 'done', bytes: 1 },
      null,
    ]))
    const s = new RecordingStore(d)
    expect(s.get('a')).toMatchObject({ source: 'scheduled', bookedMs: 67 * MIN })
    expect(s.get('b')).toMatchObject({ source: 'scheduled', bookedMs: 67 * MIN })   // made as it started, but a booking's part 2
    expect(s.get('c')).toMatchObject({ source: 'manual', bookedMs: null })
    expect(s.usedBytes()).toBe(13)
    fs.rmSync(d, { recursive: true, force: true })
  })

  it('a booking keeps how long it was booked for (with its padding); its part 2 the same', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rec-booked-'))
    const s = new RecordingStore(d)
    const r = s.schedule({ channelId: '1', startAt: T0, endAt: T0 + 60 * MIN, padBeforeMin: 2, padAfterMin: 5 })
    expect(r.bookedMs).toBe(67 * MIN)
    expect(s.schedule({ ...r, startAt: T0 + 30 * MIN, partOf: r.id }).bookedMs).toBe(67 * MIN)
    expect(s.schedule({ channelId: '1', startAt: T0, endAt: T0 + 10 * MIN, source: 'manual' }).bookedMs).toBe(null)
    fs.rmSync(d, { recursive: true, force: true })
  })

  it('says how one was started: saved with it, or — older ones — guessed from when it was made', () => {
    expect(sourceOf({ source: 'manual', startAt: T0, createdAt: T0 - 60 * MIN })).toBe('manual')
    expect(sourceOf({ startAt: T0, createdAt: T0 + 200 })).toBe('manual')                 // Record now: made as it started
    expect(sourceOf({ startAt: T0 - 2 * MIN, createdAt: T0 - 60 * MIN })).toBe('scheduled') // booked ahead
  })

  it('lists newest first, per viewer or all', () => {
    const a = book()
    now += 1000
    const b = book({ viewerId: 'view_b', title: 'Late Film' })
    expect(store.list().map((r) => r.id)).toEqual([b.id, a.id])
    expect(store.list('view_a').map((r) => r.id)).toEqual([a.id])
  })

  it('due() returns what should be recording now', () => {
    const r = book()
    expect(store.due(T0 - 3 * MIN)).toEqual([])
    expect(store.due(T0 - 2 * MIN).map((x) => x.id)).toEqual([r.id])
    expect(store.due(T0 + 30 * MIN).map((x) => x.id)).toEqual([r.id])
    expect(store.due(T0 + 65 * MIN)).toEqual([])
    store.update(r.id, { status: 'cancelled' })
    expect(store.due(T0)).toEqual([])
  })

  it('survives a reload from disk', () => {
    const r = book()
    store.update(r.id, { status: 'done', bytes: 1234, filePath: '/rec/x.ts' })
    const again = new RecordingStore(dir, { now: () => now })
    expect(again.get(r.id)).toMatchObject({ status: 'done', bytes: 1234, filePath: '/rec/x.ts' })
    expect(again.remove(r.id)).toBe(true)
    expect(new RecordingStore(dir).get(r.id)).toBeNull()
  })

  it('overlapping() finds clashes', () => {
    const r = book()
    expect(store.overlapping(T0 + 64 * MIN, T0 + 90 * MIN).map((x) => x.id)).toEqual([r.id])
    expect(store.overlapping(T0 + 65 * MIN, T0 + 90 * MIN)).toEqual([])
    store.update(r.id, { status: 'done' })
    expect(store.overlapping(T0, T0 + 10 * MIN)).toEqual([])   // only what's still to record clashes
  })

  it("nextStart(): the earliest booked start, anyone's, or null", () => {
    expect(store.nextStart()).toBeNull()
    book({ viewerId: 'view_b', startAt: T0 + 600 * MIN, endAt: T0 + 660 * MIN })
    const soon = book({ startAt: T0 + 60 * MIN, endAt: T0 + 120 * MIN })
    expect(store.nextStart()).toBe(T0 + 58 * MIN)
    store.update(soon.id, { status: 'cancelled' })
    expect(store.nextStart()).toBe(T0 + 598 * MIN)
  })

  it('nextStart() leaves out a booking whose end has already passed', () => {
    book({ startAt: T0 - 120 * MIN, endAt: T0 - 90 * MIN })   // over before now (a tick was missed)
    expect(store.nextStart(T0 - 30 * MIN)).toBeNull()
  })
})
