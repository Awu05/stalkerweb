import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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
    app.use('/api/recordings', recordingsModule(appState, { settings: () => settings, viewerName: (id) => viewers.get?.(id)?.name ?? (id === andy ? 'Andy' : id === bea ? 'Bea' : '') }))
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
    expect(del.status).toBe(204)
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

  it('only the owner sees theirs unless all=1', async () => {
    expect((await call('GET', '/api/recordings', null, bea)).body.recordings).toEqual([])
    const all = (await call('GET', '/api/recordings?all=1', null, bea)).body.recordings
    expect(all.length).toBeGreaterThan(0)
    expect(all[0]).toHaveProperty('viewerName', 'Andy')
    expect((await call('DELETE', `/api/recordings/${all[0].id}`, null, bea)).status).toBe(404)   // not hers to delete
  })
})
