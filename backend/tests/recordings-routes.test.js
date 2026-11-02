import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { createRequire } from 'module'
import ViewersManager from '../viewers/ViewersManager.js'
import { createViewerContext } from '../lib/viewerContext.js'

const require = createRequire(import.meta.url)
const RecordingStore = require('../recordings/RecordingStore.js')
const { RecordingScheduler } = require('../recordings/RecordingScheduler.js')
const recordingsModule = require('../routes/recordings.js')
const proxyRecording = require('../routes/recordingFile.js')

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 1, 20, 0)
let server, base, dir, andy, bea, appState, settings, clock, running

describe('/api/recordings', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rec-routes-'))
    const viewers = new ViewersManager(dir)
    viewers.ensureInitialized({})
    andy = viewers.create({ name: 'Andy' }).id
    bea = viewers.create({ name: 'Bea' }).id
    clock = { t: T0 - 30 * MIN }
    const store = new RecordingStore(dir, { now: () => clock.t })
    running = []
    const start = (o) => new Promise((resolve) => {
      running.push(o)
      fs.writeFileSync(o.filePath + '.part', Buffer.from('ts-bytes-0123456789'))
      o.signal.addEventListener('abort', () => { fs.renameSync(o.filePath + '.part', o.filePath); resolve({ status: 'done', bytes: 19 }) }, { once: true })
    })
    const scheduler = new RecordingScheduler({ store, start, now: () => clock.t, tickMs: 1e9, urlFor: (id) => `http://x/proxy/stream/${id}`, dirFor: () => dir, timeZone: 'UTC' })
    settings = { max_streams: 1, record_pad_before_min: 2, record_pad_after_min: 5 }
    appState = { recordings: scheduler, recordingStore: store, activeStreams: 0, sessionManager: { isAuthenticated: () => true } }
    const app = express()
    app.use(express.json())
    app.use(createViewerContext(viewers).middleware)
    app.use('/api/recordings', recordingsModule(appState, { now: () => clock.t, settings: () => settings, viewerOf: (id) => viewers.get(id) }))
    app.use('/proxy', proxyRecording(appState))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => { await appState.recordings.stopAll(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  beforeEach(() => { appState.activeStreams = 0 })

  const call = async (method, p, body, viewer = andy, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Viewer': viewer, ...headers }, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    let json = null; try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: r.status, body: json, text, headers: r.headers }
  }
  const programme = (o = {}) => ({ channelId: '7', channelName: 'News 24', title: 'Evening News', startAt: T0, endAt: T0 + 60 * MIN, ...o })

  it('schedules from a guide programme with the padding from settings', async () => {
    const r = await call('POST', '/api/recordings', programme())
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ status: 'scheduled', title: 'Evening News', startAt: T0 - 2 * MIN, endAt: T0 + 65 * MIN, viewerId: andy })
  })

  it('refuses an overlapping recording with max_streams 1', async () => {
    const r = await call('POST', '/api/recordings', programme({ channelId: '8', title: 'Quiz', startAt: T0 + 30 * MIN, endAt: T0 + 90 * MIN }))
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/overlaps/i)
    expect(r.body.clash).toMatchObject({ title: 'Evening News' })
    settings.max_streams = 2
    expect((await call('POST', '/api/recordings', programme({ channelId: '8', title: 'Quiz', startAt: T0 + 30 * MIN, endAt: T0 + 90 * MIN }))).status).toBe(201)
    settings.max_streams = 1
  })

  it('record now warns when watching uses the stream, and force starts it', async () => {
    appState.activeStreams = 1
    const warned = await call('POST', '/api/recordings/now', { channelId: '9', channelName: 'Sports 1', title: 'Match', endAt: null })
    expect(warned.status).toBe(409)
    expect(warned.body).toMatchObject({ takesStream: true })
    expect(warned.body.error).toMatch(/1 stream/)
    const forced = await call('POST', '/api/recordings/now', { channelId: '9', channelName: 'Sports 1', title: 'Match', endAt: null, force: true })
    expect(forced.status).toBe(201)
    expect(forced.body).toMatchObject({ status: 'recording', channelId: '9' })
    expect(running.at(-1)).toMatchObject({ endAt: null })
  })

  it('stop and delete; deleting a running recording stops it first', async () => {
    const now = await call('POST', '/api/recordings/now', { channelId: '10', channelName: 'Movies', title: 'Film', endAt: T0 + 120 * MIN, force: true })
    const id = now.body.id
    const del = await call('DELETE', `/api/recordings/${id}`)
    expect(del.status).toBe(200)
    expect((await call('GET', '/api/recordings')).body.recordings.find((x) => x.id === id)).toBeUndefined()
    expect(fs.readdirSync(dir).some((f) => f.includes('Film'))).toBe(false)   // no file left, finished or half-written

    const again = await call('POST', '/api/recordings/now', { channelId: '10', channelName: 'Movies', title: 'Film 2', endAt: null, force: true })
    expect((await call('POST', `/api/recordings/${again.body.id}/stop`)).status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect((await call('GET', '/api/recordings')).body.recordings.find((x) => x.id === again.body.id)).toMatchObject({ status: 'done', bytes: 19 })
  })

  it('plays a finished recording with Range', async () => {
    const done = (await call('GET', '/api/recordings')).body.recordings.find((x) => x.status === 'done')
    const whole = await call('GET', `/proxy/recording/${done.id}`)
    expect(whole.status).toBe(200)
    expect(whole.text).toBe('ts-bytes-0123456789')
    const part = await call('GET', `/proxy/recording/${done.id}`, null, andy, { Range: 'bytes=3-7' })
    expect(part.status).toBe(206)
    expect(part.text).toBe('bytes')
    expect((await call('GET', '/proxy/recording/nope')).status).toBe(404)
  })

  it('serves a finished recording as HLS byte ranges into its one file', async () => {
    const done = (await call('GET', '/api/recordings')).body.recordings.find((x) => x.status === 'done')
    expect((await call('GET', `/proxy/recording/${done.id}/index.m3u8`)).status).toBe(404)   // no index yet
    const NL = String.fromCharCode(10)
    fs.writeFileSync(`${done.filePath}.index`, ['{"o":0,"l":8,"d":4.0}', '{"o":8,"l":11,"d":3.5,"disc":true}'].join(NL) + NL)
    const m3u8 = await call('GET', `/proxy/recording/${done.id}/index.m3u8`)
    expect(m3u8.status).toBe(200)
    expect(m3u8.headers.get('content-type')).toMatch(/mpegurl/)
    expect(m3u8.text).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(m3u8.text).toContain('#EXT-X-TARGETDURATION:4')
    expect(m3u8.text).toContain(`#EXTINF:4.000,
#EXT-X-BYTERANGE:8@0
../${done.id}`)
    expect(m3u8.text).toContain(`#EXT-X-DISCONTINUITY
#EXTINF:3.500,
#EXT-X-BYTERANGE:11@8
../${done.id}`)
    expect(m3u8.text.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })

  it('serves only the whole index lines, and only pieces inside the file', async () => {
    const done = (await call('GET', '/api/recordings')).body.recordings.find((x) => x.status === 'done')
    const NL = String.fromCharCode(10)
    fs.writeFileSync(`${done.filePath}.index`, ['{"o":0,"l":8,"d":4.0}', '{"o":8,"l":50,"d":4.0}', '{"o":58,"l":'].join(NL))
    const m3u8 = await call('GET', `/proxy/recording/${done.id}/index.m3u8`)
    expect(m3u8.status).toBe(200)
    expect(m3u8.text.match(/#EXT-X-BYTERANGE/g)).toHaveLength(1)
    expect(m3u8.text).toContain('#EXT-X-BYTERANGE:8@0')
  })

  it('only the owner sees theirs unless all=1', async () => {
    expect((await call('GET', '/api/recordings', null, bea)).body.recordings).toEqual([])
    const all = (await call('GET', '/api/recordings?all=1', null, bea)).body.recordings
    expect(all.length).toBeGreaterThan(0)
    expect(all[0]).toHaveProperty('viewerName', 'Andy')
    expect((await call('DELETE', `/api/recordings/${all[0].id}`, null, bea)).status).toBe(404)   // not hers to delete
  })

  it("anyone can stop or cancel a household recording (to clear a clash), but only its owner deletes it", async () => {
    const booked = await call('POST', '/api/recordings', programme({ channelId: '20', title: 'Late Show', startAt: T0 + 300 * MIN, endAt: T0 + 360 * MIN }))
    expect(booked.status).toBe(201)
    const cancelled = await call('POST', `/api/recordings/${booked.body.id}/stop`, null, bea)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('cancelled')
    expect((await call('DELETE', `/api/recordings/${booked.body.id}`, null, bea)).status).toBe(404)
    expect((await call('POST', '/api/recordings/nope/stop', null, bea)).status).toBe(404)
  })
})

// A fresh app per test: its own folder, store, clock and settings.
async function makeApp({ dirFor, activity } = {}) {
  const { ActivityTracker } = require('../lib/activity.js')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rec-routes2-'))
  const viewers = new ViewersManager(d)
  viewers.ensureInitialized({})
  const me = viewers.create({ name: 'Andy' }).id
  const c = { t: T0 - 30 * MIN }
  const store = new RecordingStore(d, { now: () => c.t })
  const start = (o) => new Promise((resolve) => {
    fs.writeFileSync(o.filePath + '.part', Buffer.from('ts-bytes'))
    o.signal.addEventListener('abort', () => { fs.renameSync(o.filePath + '.part', o.filePath); resolve({ status: 'done', bytes: 8 }) }, { once: true })
  })
  const scheduler = new RecordingScheduler({ store, start, now: () => c.t, tickMs: 1e9, urlFor: (id) => `http://x/proxy/stream/${id}`, dirFor: dirFor || (() => d), timeZone: 'UTC' })
  const s = { max_streams: 1, record_pad_before_min: 0, record_pad_after_min: 0 }
  const st = { recordings: scheduler, recordingStore: store, activeStreams: 0, activity: activity ?? new ActivityTracker({ now: () => c.t }) }
  const app = express()
  app.use(express.json())
  app.use(createViewerContext(viewers).middleware)
  app.use('/api/recordings', recordingsModule(st, { settings: () => s, now: () => c.t }))
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)) })
  const b = `http://127.0.0.1:${srv.address().port}`
  const send = async (method, p, body) => {
    const r = await fetch(b + p, { method, headers: { 'Content-Type': 'application/json', 'X-Viewer': me }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const close = async () => { await scheduler.stopAll(); srv.closeAllConnections(); srv.close(); fs.rmSync(d, { recursive: true, force: true }) }
  return { dir: d, clock: c, store, scheduler, settings: s, appState: st, send, close }
}

describe('/api/recordings — the stream limit and the clash check', () => {
  let a
  beforeEach(async () => { a = await makeApp() })
  afterEach(async () => { await a.close() })
  const at = (h, m = 0) => Date.UTC(2026, 10, 3, h, m)
  const prog = (from, to, o = {}) => ({ channelId: '7', channelName: 'News 24', title: 'Show', startAt: from, endAt: to, ...o })

  it('refuses a programme that has already ended', async () => {
    const r = await a.send('POST', '/api/recordings', prog(T0 - 120 * MIN, T0 - 40 * MIN))
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('That programme has already ended.')
  })

  it('counts the most running at once, not every booking that overlaps', async () => {
    a.settings.max_streams = 2
    expect((await a.send('POST', '/api/recordings', prog(at(13), at(14), { title: 'A' }))).status).toBe(201)
    expect((await a.send('POST', '/api/recordings', prog(at(15), at(16), { title: 'B' }))).status).toBe(201)
    expect((await a.send('POST', '/api/recordings', prog(at(12, 30), at(16, 30), { title: 'C' }))).status).toBe(201)
    // Now 13–14 has A and C: a third there is one too many.
    const d = await a.send('POST', '/api/recordings', prog(at(13, 15), at(13, 45), { title: 'D' }))
    expect(d.status).toBe(409)
    expect(d.body.clash).toBeTruthy()
  })

  it('an until-stopped recording counts as running for the next 2 hours', async () => {
    a.appState.activity = null
    expect((await a.send('POST', '/api/recordings/now', { channelId: '9', title: 'Match', endAt: null })).status).toBe(201)
    const week = 7 * 24 * 60 * MIN
    const nextWeek = await a.send('POST', '/api/recordings', prog(a.clock.t + week, a.clock.t + week + 60 * MIN))
    expect(nextWeek.status).toBe(201)
    const soon = await a.send('POST', '/api/recordings', prog(a.clock.t + 30 * MIN, a.clock.t + 90 * MIN))
    expect(soon.status).toBe(409)
    expect(soon.body.error).toMatch(/overlaps "Match"/)
  })

  it('record now counts a viewer playing HLS (seen lately, no stream open)', async () => {
    a.appState.activity.touch({ ip: '192.168.1.20', ua: 'Mozilla/5.0', kind: 'live', id: '5' })()   // a playlist fetch, over
    expect(a.appState.activeStreams).toBe(0)
    const r = await a.send('POST', '/api/recordings/now', { channelId: '9', title: 'Match', endAt: null })
    expect(r.status).toBe(409)
    expect(r.body.takesStream).toBe(true)
  })

  it('a guide booking that starts now, or within 5 minutes, warns when the stream is in use', async () => {
    a.appState.activeStreams = 1
    const now = await a.send('POST', '/api/recordings', prog(a.clock.t + 3 * MIN, a.clock.t + 60 * MIN))
    expect(now.status).toBe(409)
    expect(now.body.takesStream).toBe(true)
    expect(a.store.list()).toHaveLength(0)
    const later = await a.send('POST', '/api/recordings', prog(a.clock.t + 60 * MIN, a.clock.t + 120 * MIN, { channelId: '8' }))
    expect(later.status).toBe(201)
    const forced = await a.send('POST', '/api/recordings', { ...prog(a.clock.t + 3 * MIN, a.clock.t + 30 * MIN), force: true })
    expect(forced.status).toBe(201)
  })

  it('two identical bookings record to two files; deleting one leaves the other', async () => {
    a.settings.max_streams = 2
    const one = await a.send('POST', '/api/recordings', prog(T0, T0 + 60 * MIN))
    const two = await a.send('POST', '/api/recordings', prog(T0, T0 + 60 * MIN))
    a.clock.t = T0
    await a.scheduler.tick()
    const f1 = a.store.get(one.body.id).filePath
    const f2 = a.store.get(two.body.id).filePath
    expect(f1).not.toBe(f2)
    expect((await a.send('DELETE', `/api/recordings/${one.body.id}`)).status).toBe(200)
    expect(fs.existsSync(f2 + '.part')).toBe(true)
  })
})

describe("/api/recordings — record now that can't start", () => {
  it('answers 500 with why, and leaves no booking waiting', async () => {
    const a = await makeApp({ dirFor: () => { throw new Error('EACCES: permission denied') } })
    try {
      const r = await a.send('POST', '/api/recordings/now', { channelId: '9', title: 'Match', endAt: null })
      expect(r.status).toBe(500)
      expect(r.body.error).toMatch(/couldn't start.*permission denied/i)
      expect(a.store.list().some((x) => x.status === 'scheduled')).toBe(false)
    } finally { await a.close() }
  })
})

describe('recording playlists', () => {
  const { playlistOf } = require('../routes/recordingFile.js')
  const { parsePieces } = require('../recordings/pieceIndex.js')

  it('keeps only the whole index lines inside the file', () => {
    const text = '{"o":0,"l":8,"d":4}\nnot json\n{"o":8,"l":11,"d":3.5}\n{"o":19,"l":50,"d":4}\n{"o":69,"l":'
    expect(parsePieces(text, 19)).toEqual([{ o: 0, l: 8, d: 4 }, { o: 8, l: 11, d: 3.5 }])
  })

  it('makes a playlist of 200 000 pieces', () => {
    const pieces = Array.from({ length: 200_000 }, (_, i) => ({ o: i * 10, l: 10, d: i === 7 ? 9.2 : 4 }))
    const m3u8 = playlistOf(pieces, '../r')
    expect(m3u8).toContain('#EXT-X-TARGETDURATION:10')
  })
})

// A household: Default (Solo's only viewer), Andy, Bea and Kid, with channels (one adult, one in a genre Kid hides).
async function makeHousehold() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rec-household-'))
  const viewers = new ViewersManager(d)
  viewers.ensureInitialized({})
  const ids = { default: viewers.getDefault().id, andy: viewers.create({ name: 'Andy' }).id, bea: viewers.create({ name: 'Bea' }).id, kid: viewers.create({ name: 'Kid' }).id }
  viewers.setFilters(ids.andy, { showAdult: true })
  viewers.setFilters(ids.kid, { disabledGenres: ['Sport'] })
  const channels = [
    { id: '7', name: 'News 24', genre: 'News' },
    { id: '66', name: 'Late Night', genre: 'Adult' },
    { id: '9', name: 'Sports 1', genre: 'Sport' },
  ]
  const c = { t: T0 - 30 * MIN }
  const store = new RecordingStore(d, { now: () => c.t })
  const start = (o) => new Promise((resolve) => {
    fs.writeFileSync(o.filePath + '.part', Buffer.from('ts-bytes-0123456789'))
    o.signal.addEventListener('abort', () => { fs.renameSync(o.filePath + '.part', o.filePath); resolve({ status: 'done', bytes: 19 }) }, { once: true })
  })
  const scheduler = new RecordingScheduler({ store, start, now: () => c.t, tickMs: 1e9, urlFor: (id) => `http://x/proxy/stream/${id}`, dirFor: () => d, timeZone: 'UTC' })
  const s = { max_streams: 4, record_pad_before_min: 0, record_pad_after_min: 0 }
  const st = { recordings: scheduler, recordingStore: store, activeStreams: 0 }
  const disk = { free: 50 * 1024 ** 3 }
  const opts = { viewerOf: (id) => viewers.get(id), channels: () => channels, isAdmin: (v) => viewers.isAdmin(v?.id), freeBytes: () => disk.free }
  const app = express()
  app.use(express.json())
  app.use(createViewerContext(viewers).middleware)
  app.use('/api/recordings', recordingsModule(st, { settings: () => s, now: () => c.t, ...opts }))
  app.use('/proxy', proxyRecording(st, opts))
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)) })
  const b = `http://127.0.0.1:${srv.address().port}`
  // as: a viewer id (sent as X-Viewer), or null for none (Solo, a cast device).
  const send = async (method, p, body, as = null) => {
    const headers = { 'Content-Type': 'application/json', ...(as ? { 'X-Viewer': as } : {}) }
    const r = await fetch(b + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    let json = null; try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: r.status, body: json, text }
  }
  const finished = (o) => {
    const r = store.schedule({ channelName: 'News 24', title: 'Show', startAt: T0 - 120 * MIN, endAt: T0 - 60 * MIN, channelId: '7', ...o })
    const filePath = path.join(d, `${r.id}.ts`)
    fs.writeFileSync(filePath, 'ts-bytes')
    fs.writeFileSync(`${filePath}.index`, '{"o":0,"l":8,"d":4.0}\n')
    return store.update(r.id, { status: 'done', bytes: 8, filePath })
  }
  const close = async () => { await scheduler.stopAll(); srv.closeAllConnections(); srv.close(); fs.rmSync(d, { recursive: true, force: true }) }
  return { ids, viewers, store, scheduler, clock: c, send, finished, close, disk }
}

describe('/api/recordings — who owns one, and who may see it', () => {
  let h
  beforeEach(async () => { h = await makeHousehold() })
  afterEach(async () => { await h.close() })
  const row = (res, id) => res.body.recordings.find((x) => x.id === id)

  it('every row says whether it is mine and whether I may delete it', async () => {
    const a = h.finished({ viewerId: h.ids.andy })
    const mineToAndy = row(await h.send('GET', '/api/recordings?all=1', null, h.ids.andy), a.id)
    expect(mineToAndy).toMatchObject({ mine: true, canDelete: true, viewerName: 'Andy' })
    const toBea = row(await h.send('GET', '/api/recordings?all=1', null, h.ids.bea), a.id)
    expect(toBea).toMatchObject({ mine: false, canDelete: false })
    expect(row(await h.send('GET', '/api/recordings', null, h.ids.andy), a.id)).toMatchObject({ mine: true, canDelete: true })
  })

  it('Solo (no X-Viewer: the Default viewer) may delete its own recordings', async () => {
    const booked = await h.send('POST', '/api/recordings/now', { channelId: '7', channelName: 'News 24', title: 'Solo', endAt: null, force: true })
    expect(booked.body.viewerId).toBe(h.ids.default)
    await h.send('POST', `/api/recordings/${booked.body.id}/stop`)
    await h.scheduler.settled(booked.body.id)
    const r = row(await h.send('GET', '/api/recordings'), booked.body.id)
    expect(r).toMatchObject({ mine: true, canDelete: true })
    // A stale web viewer id the server maps to Default: the same.
    expect(row(await h.send('GET', '/api/recordings', null, 'view_stale'), booked.body.id)).toMatchObject({ canDelete: true })
    expect((await h.send('DELETE', `/api/recordings/${booked.body.id}`)).status).toBe(200)
  })

  it("a recording whose viewer is gone is anyone's to delete, shown as (deleted viewer)", async () => {
    const gone = h.viewers.create({ name: 'Gone' }).id
    const a = h.finished({ viewerId: gone })
    const b = h.finished({ viewerId: 'view_unreadable' })
    h.viewers.remove(gone)
    const all = await h.send('GET', '/api/recordings?all=1', null, h.ids.bea)
    expect(row(all, a.id)).toMatchObject({ viewerName: '(deleted viewer)', mine: false, canDelete: true })
    expect(row(all, b.id)).toMatchObject({ viewerName: '(deleted viewer)', canDelete: true })
    expect((await h.send('DELETE', `/api/recordings/${a.id}`, null, h.ids.bea)).status).toBe(200)
    expect(h.store.get(a.id)).toBeNull()
  })

  it("the admin (the first viewer) may delete anyone's recording; others still only their own", async () => {
    const a = h.finished({ viewerId: h.ids.andy })
    const f = h.store.schedule({ viewerId: h.ids.bea, channelId: '7', channelName: 'News 24', title: 'Broken', startAt: T0 - 60 * MIN, endAt: T0 - 30 * MIN })
    h.store.update(f.id, { status: 'failed', error: 'no signal' })
    const toAdmin = await h.send('GET', '/api/recordings?all=1', null, h.ids.default)
    expect(row(toAdmin, a.id)).toMatchObject({ mine: false, canDelete: true })
    expect(row(toAdmin, f.id)).toMatchObject({ mine: false, canDelete: true })
    expect(row(await h.send('GET', '/api/recordings?all=1', null, h.ids.bea), a.id)).toMatchObject({ canDelete: false })
    expect((await h.send('DELETE', `/api/recordings/${a.id}`, null, h.ids.bea)).status).toBe(404)
    expect((await h.send('DELETE', `/api/recordings/${a.id}`, null, h.ids.default)).status).toBe(200)
    expect(h.store.get(a.id)).toBeNull()
    expect((await h.send('DELETE', `/api/recordings/${f.id}`, null, h.ids.default)).status).toBe(200)
  })

  it('the list says how much the recordings take on the disk, and how much is free', async () => {
    h.finished({ viewerId: h.ids.andy })
    h.finished({ viewerId: h.ids.bea })
    const r = await h.send('GET', '/api/recordings', null, h.ids.bea)
    // Everyone's, whichever list was asked for: it's the disk they share.
    expect(r.body.disk).toEqual({ usedBytes: 16, freeBytes: 50 * 1024 ** 3 })
    h.disk.free = null   // unknown (statfs failed)
    expect((await h.send('GET', '/api/recordings?all=1', null, h.ids.bea)).body.disk).toEqual({ usedBytes: 16, freeBytes: null })
  })

  it("someone else's failed one stays undeletable for me; once its viewer is gone, it isn't", async () => {
    const f = h.store.schedule({ viewerId: h.ids.andy, channelId: '7', channelName: 'News 24', title: 'Broken', startAt: T0 - 60 * MIN, endAt: T0 - 30 * MIN })
    h.store.update(f.id, { status: 'failed', error: 'no signal' })
    expect(row(await h.send('GET', '/api/recordings?all=1', null, h.ids.bea), f.id)).toMatchObject({ canDelete: false })
    expect((await h.send('DELETE', `/api/recordings/${f.id}`, null, h.ids.bea)).status).toBe(404)
    h.viewers.remove(h.ids.andy)
    expect(row(await h.send('GET', '/api/recordings?all=1', null, h.ids.bea), f.id)).toMatchObject({ canDelete: true })
  })

  it("a viewer without Show Adult neither lists nor plays another viewer's adult-channel recording; its owner does", async () => {
    const adult = h.finished({ viewerId: h.ids.andy, channelId: '66', channelName: 'Late Night', title: 'After Dark' })
    const news = h.finished({ viewerId: h.ids.andy })
    const toBea = await h.send('GET', '/api/recordings?all=1', null, h.ids.bea)
    expect(row(toBea, adult.id)).toBeUndefined()
    expect(row(toBea, news.id)).toBeTruthy()
    expect((await h.send('GET', `/proxy/recording/${adult.id}`, null, h.ids.bea)).status).toBe(404)
    expect((await h.send('GET', `/proxy/recording/${adult.id}/index.m3u8`, null, h.ids.bea)).status).toBe(404)
    expect((await h.send('GET', `/proxy/recording/${adult.id}?viewer=${h.ids.bea}`)).status).toBe(404)
    expect((await h.send('GET', `/proxy/recording/${news.id}`, null, h.ids.bea)).status).toBe(200)
    // The owner lists and plays it.
    expect(row(await h.send('GET', '/api/recordings?all=1', null, h.ids.andy), adult.id)).toBeTruthy()
    expect((await h.send('GET', `/proxy/recording/${adult.id}`, null, h.ids.andy)).status).toBe(200)
    // A cast device or share link names no viewer: it plays.
    expect((await h.send('GET', `/proxy/recording/${adult.id}`)).status).toBe(200)
  })

  it('a hidden genre hides the recordings of its channels too — but never my own', async () => {
    const sport = h.finished({ viewerId: h.ids.andy, channelId: '9', channelName: 'Sports 1', title: 'Match' })
    const kids = h.finished({ viewerId: h.ids.kid, channelId: '9', channelName: 'Sports 1', title: 'My Match' })
    const toKid = await h.send('GET', '/api/recordings?all=1', null, h.ids.kid)
    expect(row(toKid, sport.id)).toBeUndefined()
    expect(row(toKid, kids.id)).toBeTruthy()
    expect((await h.send('GET', `/proxy/recording/${kids.id}`, null, h.ids.kid)).status).toBe(200)
  })

  it('the HLS playlist keeps the viewer named in its link on the file it points at', async () => {
    const news = h.finished({ viewerId: h.ids.bea })
    const m3u8 = await h.send('GET', `/proxy/recording/${news.id}/index.m3u8?viewer=${h.ids.bea}`)
    expect(m3u8.status).toBe(200)
    expect(m3u8.text).toContain(`../${news.id}?viewer=${h.ids.bea}`)
    expect((await h.send('GET', `/proxy/recording/${news.id}/index.m3u8`)).text).toContain(`../${news.id}\n`)
  })
})

describe('/api/recordings — stopping or cancelling someone else’s', () => {
  let h, infos
  beforeEach(async () => {
    h = await makeHousehold()
    const log = require('../logger.js')
    infos = []
    vi.spyOn(log, 'info').mockImplementation((tag, msg) => { infos.push(`${tag} ${msg}`) })
  })
  afterEach(async () => { vi.restoreAllMocks(); await h.close() })

  it('another viewer stopping a running one: it ends done, what it has kept, and says who stopped it', async () => {
    const r = await h.send('POST', '/api/recordings/now', { channelId: '7', channelName: 'News 24', title: 'Long One', endAt: null, force: true }, h.ids.andy)
    const stopped = await h.send('POST', `/api/recordings/${r.body.id}/stop`, null, h.ids.bea)
    expect(stopped.status).toBe(200)
    await h.scheduler.settled(r.body.id)
    expect(h.store.get(r.body.id)).toMatchObject({ status: 'done', bytes: 19, stoppedBy: 'Bea' })
    expect(fs.existsSync(h.store.get(r.body.id).filePath)).toBe(true)
    expect(infos.some((l) => /stopped "Long One".*Bea/.test(l))).toBe(true)
    expect(infos.join('\n')).not.toContain(h.ids.bea)
  })

  it('another viewer cancelling a booked one says who; the owner stopping their own says nothing', async () => {
    const booked = await h.send('POST', '/api/recordings', { channelId: '7', channelName: 'News 24', title: 'Later', startAt: T0 + 300 * MIN, endAt: T0 + 360 * MIN }, h.ids.andy)
    const cancelled = await h.send('POST', `/api/recordings/${booked.body.id}/stop`, null, h.ids.bea)
    expect(cancelled.body).toMatchObject({ status: 'cancelled', stoppedBy: 'Bea' })
    expect(infos.some((l) => /cancelled "Later".*Bea/.test(l))).toBe(true)
    const own = await h.send('POST', '/api/recordings', { channelId: '7', channelName: 'News 24', title: 'Mine', startAt: T0 + 400 * MIN, endAt: T0 + 460 * MIN }, h.ids.andy)
    const ownCancel = await h.send('POST', `/api/recordings/${own.body.id}/stop`, null, h.ids.andy)
    expect(ownCancel.body.status).toBe('cancelled')
    expect(ownCancel.body.stoppedBy).toBeUndefined()
    expect(infos.some((l) => /cancelled "Mine"/.test(l))).toBe(true)
  })
})
