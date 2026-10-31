import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const RecordingStore = require('../recordings/RecordingStore.js')
const { RecordingScheduler, recordingName } = require('../recordings/RecordingScheduler.js')

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 31, 20, 0)
let dir, clock, store, started, sched

// A recorder that runs until stopped (or its end, when the test says so).
function fakeStart() {
  return (o) => new Promise((resolve) => {
    const entry = { o, finish: (r) => resolve(r) }
    started.push(entry)
    o.signal.addEventListener('abort', () => resolve({ status: 'done', bytes: 10 }), { once: true })
  })
}

function makeScheduler() {
  return new RecordingScheduler({
    store, start: fakeStart(), now: () => clock.t, tickMs: 1_000_000,
    urlFor: (id) => `http://127.0.0.1:8983/proxy/stream/${id}`, dirFor: () => dir, timeZone: 'UTC',
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sched-'))
  clock = { t: T0 - 30 * MIN }
  started = []
  store = new RecordingStore(dir, { now: () => clock.t })
  sched = makeScheduler()
})
afterEach(async () => { await sched.stopAll(); fs.rmSync(dir, { recursive: true, force: true }) })

const book = (o = {}) => store.schedule({ viewerId: 'view_a', channelId: '7', channelName: 'News 24', title: 'Evening News',
  startAt: T0, endAt: T0 + 60 * MIN, padBeforeMin: 2, padAfterMin: 5, ...o })
const flush = () => new Promise((r) => setTimeout(r, 5))

describe('RecordingScheduler', () => {
  it('starts a scheduled recording at its start and stops at its end', async () => {
    const r = book()
    await sched.tick()
    expect(started).toHaveLength(0)
    clock.t = T0 - 2 * MIN
    await sched.tick()
    expect(started).toHaveLength(1)
    expect(started[0].o).toMatchObject({ url: 'http://127.0.0.1:8983/proxy/stream/7', endAt: T0 + 65 * MIN })
    expect(store.get(r.id).status).toBe('recording')
    expect(sched.active()).toEqual([r.id])
    started[0].finish({ status: 'done', bytes: 4096 })
    await flush()
    expect(store.get(r.id)).toMatchObject({ status: 'done', bytes: 4096, endedAt: clock.t })
    expect(sched.active()).toEqual([])
  })

  it('after a restart, keeps the part written as "(part 1)" and starts "(part 2)" for the rest; marks one whose time passed as missed', async () => {
    const r = book()
    const late = book({ title: 'Morning Show', startAt: T0 - 120 * MIN, endAt: T0 - 60 * MIN, padBeforeMin: 0, padAfterMin: 0 })
    // The last run was recording r when it stopped: its .part is on disk.
    const file = path.join(dir, recordingName(store.get(r.id), 'UTC'))
    fs.writeFileSync(file + '.part', Buffer.alloc(2048))
    store.update(r.id, { status: 'recording', filePath: file })
    clock.t = T0 + 10 * MIN
    sched = makeScheduler()
    await sched.run()
    const one = store.get(r.id)
    expect(one).toMatchObject({ status: 'done', bytes: 2048 })
    expect(one.title).toBe('Evening News (part 1)')
    expect(fs.existsSync(one.filePath)).toBe(true)
    const two = store.list().find((x) => x.partOf === r.id)
    expect(two).toMatchObject({ status: 'recording', title: 'Evening News (part 2)', endAt: T0 + 65 * MIN })
    expect(started.map((s) => s.o.endAt)).toEqual([T0 + 65 * MIN])
    expect(store.get(late.id).status).toBe('missed')
  })

  it('keeps the booked times when the guide changes later', async () => {
    const r = book()
    // The programme moves to 20:30 in the guide: nothing re-reads it — what was booked stays.
    clock.t = T0 - 2 * MIN
    await sched.tick()
    expect(store.get(r.id)).toMatchObject({ startAt: T0 - 2 * MIN, endAt: T0 + 65 * MIN })
    expect(started[0].o.endAt).toBe(T0 + 65 * MIN)
  })

  it('stop() ends a recording early, and cancels one not yet started', async () => {
    const r = book()
    const later = book({ title: 'Late Film', startAt: T0 + 120 * MIN, endAt: T0 + 240 * MIN })
    clock.t = T0
    await sched.tick()
    expect(sched.stop(r.id)).toBe(true)
    await flush()
    expect(store.get(r.id)).toMatchObject({ status: 'done', bytes: 10 })
    expect(sched.stop(later.id)).toBe(true)
    expect(store.get(later.id).status).toBe('cancelled')
    expect(sched.stop('nope')).toBe(false)
  })

  it('records now, until a given end or until stopped', async () => {
    const r = sched.startNow({ viewerId: 'view_a', channelId: '9', channelName: 'Sports 1', title: 'Match', endAt: null })
    expect(r.status).toBe('recording')
    expect(started[0].o).toMatchObject({ endAt: null, url: 'http://127.0.0.1:8983/proxy/stream/9' })
    expect(started[0].o.filePath).toMatch(/Sports 1 – Match – 2026-10-31 19.30.ts$/)
  })

  it('names files Channel – Programme – date time, safely', () => {
    const r = { channelName: 'BBC One: HD', title: 'News / Weather?', startAt: T0 + 2 * MIN }
    expect(recordingName(r, 'UTC')).toBe('BBC One_ HD – News _ Weather_ – 2026-10-31 20.02.ts')
    expect(recordingName({ channelName: 'X', title: '', startAt: T0 }, 'UTC')).toBe('X – 2026-10-31 20.00.ts')
  })
})
