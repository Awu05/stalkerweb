import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { makeTs } from './helpers/makeTs.js'

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
    expect(two).toMatchObject({ status: 'recording', title: 'Evening News (part 2)', endAt: T0 + 65 * MIN, source: 'scheduled' })
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
    expect(store.get(r.id).source).toBe('manual')
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

describe('RecordingScheduler — when things go wrong', () => {
  const GB = 1024 ** 3
  const { startRecording } = require('../recordings/Recorder.js')

  it('a shutdown leaves the recording to be kept as part 1, and the next start records part 2', async () => {
    const LONG = makeTs({ seconds: 12, keyEvery: 2 })
    const reader = async (_u, { onData, signal }) => {
      onData(LONG)
      await new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', r, { once: true })))
    }
    sched = new RecordingScheduler({
      store, now: () => clock.t, tickMs: 1_000_000, urlFor: (id) => `http://x/proxy/stream/${id}`, dirFor: () => dir, timeZone: 'UTC',
      start: (o) => startRecording({ ...o, reader, freeBytes: () => 10 * GB, checkEveryMs: 5, retryMs: 5 }),
    })
    const r = book()
    clock.t = T0
    await sched.tick()
    await new Promise((res) => setTimeout(res, 40))
    await sched.stopAll()
    const left = store.get(r.id)
    expect(left.status).toBe('recording')
    expect(fs.existsSync(left.filePath + '.part')).toBe(true)
    expect(fs.existsSync(left.filePath + '.part.index')).toBe(true)

    clock.t = T0 + 5 * MIN
    sched = makeScheduler()
    await sched.run()
    const one = store.get(r.id)
    expect(one).toMatchObject({ status: 'done', title: 'Evening News (part 1)' })
    expect(fs.existsSync(one.filePath + '.index')).toBe(true)
    expect(store.list().find((x) => x.partOf === r.id)).toMatchObject({ status: 'recording', title: 'Evening News (part 2)' })
  })

  it('a user\'s stop still finishes it as done', async () => {
    const r = book()
    clock.t = T0
    await sched.tick()
    sched.stop(r.id)
    await flush()
    expect(store.get(r.id).status).toBe('done')
  })

  it('part 1 ends when its file was last written', async () => {
    const r = book()
    const file = path.join(dir, recordingName(store.get(r.id), 'UTC'))
    fs.writeFileSync(file + '.part', Buffer.alloc(2048))
    const when = new Date(T0 + 7 * MIN)
    fs.utimesSync(file + '.part', when, when)
    store.update(r.id, { status: 'recording', filePath: file })
    clock.t = T0 + 30 * MIN
    sched = makeScheduler()
    await sched.run()
    expect(store.get(r.id).endedAt).toBe(T0 + 7 * MIN)
  })

  it('part 1 keeps only the index lines that are whole and inside its file', async () => {
    const r = book()
    const file = path.join(dir, recordingName(store.get(r.id), 'UTC'))
    fs.writeFileSync(file + '.part', Buffer.alloc(100))
    fs.writeFileSync(file + '.part.index', '{"o":0,"l":60,"d":4}\n{"o":60,"l":80,"d":4}\n{"o":140,"l":')
    store.update(r.id, { status: 'recording', filePath: file })
    clock.t = T0 + 10 * MIN
    sched = makeScheduler()
    await sched.run()
    expect(fs.readFileSync(store.get(r.id).filePath + '.index', 'utf8')).toBe('{"o":0,"l":60,"d":4}\n')
  })

  it('one recording that can\'t start fails on its own, and the next due one still starts', async () => {
    const blocker = path.join(dir, 'not-a-folder')
    fs.writeFileSync(blocker, 'x')
    let calls = 0
    sched = new RecordingScheduler({
      store, start: fakeStart(), now: () => clock.t, tickMs: 1_000_000, urlFor: (id) => `http://x/${id}`, timeZone: 'UTC',
      dirFor: () => (++calls === 1 ? path.join(blocker, 'sub') : dir),
    })
    const a = book()
    const b = book({ channelId: '8', channelName: 'Sports 1', title: 'Match' })
    clock.t = T0
    await sched.tick()
    const fa = store.get(a.id)
    expect(fa.status).toBe('failed')
    expect(fa.error).toBeTruthy()
    expect(store.get(b.id).status).toBe('recording')
    expect(started).toHaveLength(1)
  })

  it('keeps looking every few seconds even when recovery fails', async () => {
    const r = book()
    store.update(r.id, { status: 'recording', filePath: path.join(dir, 'x.ts') })
    fs.writeFileSync(path.join(dir, 'x.ts.part'), Buffer.alloc(10))
    clock.t = T0 + 10 * MIN
    sched = new RecordingScheduler({
      store, start: fakeStart(), now: () => clock.t, tickMs: 1_000_000, urlFor: (id) => `http://x/${id}`, timeZone: 'UTC',
      dirFor: () => { throw new Error('the recordings folder is missing') },
    })
    await sched.run()
    expect(sched._timer).toBeTruthy()
    expect(store.list().find((x) => x.partOf === r.id)).toMatchObject({ status: 'failed' })
  })

  it('record now that can\'t start is marked failed and says why', () => {
    sched = new RecordingScheduler({
      store, start: fakeStart(), now: () => clock.t, tickMs: 1_000_000, urlFor: (id) => `http://x/${id}`, timeZone: 'UTC',
      dirFor: () => { throw new Error('EACCES: permission denied') },
    })
    expect(() => sched.startNow({ viewerId: 'view_a', channelId: '9', channelName: 'Sports 1', title: 'Match' })).toThrow(/couldn't start.*permission denied/i)
    expect(store.list()[0]).toMatchObject({ status: 'failed' })
    expect(store.list().some((x) => x.status === 'scheduled')).toBe(false)
  })

  it('a time zone Intl refuses still names files (in the system zone)', () => {
    sched = new RecordingScheduler({ store, start: fakeStart(), now: () => clock.t, tickMs: 1_000_000, urlFor: (id) => `http://x/${id}`, dirFor: () => dir, timeZone: 'Mars/Olympus_Mons' })
    const r = sched.startNow({ viewerId: 'view_a', channelId: '9', channelName: 'Sports 1', title: 'Match' })
    expect(r.status).toBe('recording')
    expect(started[0].o.filePath).toMatch(/Sports 1 – Match – \d{4}-\d\d-\d\d \d\d\.\d\d\.ts$/)
  })

  it('two identical bookings due in one tick record to two files', async () => {
    const a = book()
    const b = book()
    clock.t = T0
    await sched.tick()
    const fa = store.get(a.id).filePath
    const fb = store.get(b.id).filePath
    expect(fa).not.toBe(fb)
    expect(path.basename(fb)).toMatch(/ \(2\)\.ts$/)
  })

  it('caps a name at 200 bytes, shortening the title and keeping the part and the date', () => {
    const title = 'Очень длинное название передачи о природе '.repeat(10).trim() + ' (part 2)'
    const name = recordingName({ channelName: 'Первый канал', title, startAt: T0 }, 'UTC')
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200 - 15)   // room left for " (part 1)" and " (N)"
    expect(name.startsWith('Первый канал – Очень длинное')).toBe(true)
    expect(name.endsWith(' (part 2) – 2026-10-31 20.00.ts')).toBe(true)
    expect(name).not.toMatch(/�/)
    const longChannel = recordingName({ channelName: 'К'.repeat(300), title: 'Новости', startAt: T0 }, 'UTC')
    expect(Buffer.byteLength(longChannel)).toBeLessThanOrEqual(185)
    expect(longChannel).toMatch(/ – Новости – 2026-10-31 20.00.ts$/)
  })
})
