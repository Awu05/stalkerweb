import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { ActivityTracker, streamOf, vodKey } from '../lib/activity.js'
import { deviceOf } from '../lib/device.js'
import activityRoutes from '../routes/activity.js'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('streamOf', () => {
  it('knows what a proxy request plays', () => {
    expect(streamOf('/stream/1896', {})).toEqual({ kind: 'live', id: '1896', via: 'app' })
    expect(streamOf('/hls/seg/abc.ts', { ch: '1896' })).toEqual({ kind: 'live', id: '1896', via: 'app' })
    expect(streamOf('/hls', { url: 'x', ch: '7' })).toEqual({ kind: 'live', id: '7', via: 'app' })
    expect(streamOf('/cast/live/42/seg00001.ts', {})).toEqual({ kind: 'live', id: '42', via: 'cast' })
    expect(streamOf('/vod/stream.mp4', { videoId: '100' })).toEqual({ kind: 'vod', id: '100', via: 'app' })
    expect(streamOf('/vod/stream.m3u8', { videoId: '200', seasonId: 's1', episodeId: 'e3' })).toEqual({ kind: 'vod', id: '200:s1:e3', via: 'app' })
  })

  it("knows an HLS movie's playlists and segments by their key", () => {
    expect(streamOf('/hls/seg/abc.ts', { v: '200:s1:e3' })).toEqual({ kind: 'vod', id: '200:s1:e3', via: 'app' })
    expect(streamOf('/hls', { url: 'x', v: '100' })).toEqual({ kind: 'vod', id: '100', via: 'app' })
  })

  it('takes a malformed id as it is', () => {
    expect(streamOf('/stream/%E0', {})).toEqual({ kind: 'live', id: '%E0', via: 'app' })
  })

  it('keys an episode as Continue Watching does — empty parts left out', () => {
    expect(vodKey({ videoId: '200', seasonId: 's1', episodeId: 'e3' })).toBe('200:s1:e3')
    expect(vodKey({ videoId: '200', seasonId: 's1' })).toBe('200:s1')
    expect(vodKey({ videoId: '100', seasonId: '', episodeId: '' })).toBe('100')
    expect(streamOf('/vod/stream.m3u8', { videoId: '200', seasonId: 's1' }).id).toBe('200:s1')
  })

  it('leaves out what plays nothing', () => {
    expect(streamOf('/hls/seg/abc.ts', {})).toBeNull()      // no channel tag
    expect(streamOf('/logos/1.png', {})).toBeNull()
  })
})

describe('deviceOf', () => {
  it('names TVs and IPTV apps, else the browser', () => {
    expect(deviceOf('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 CrKey/1.56.500000')).toBe('Chromecast')
    expect(deviceOf('AppleCoreMedia/1.0.0.22A (Apple TV; U; CPU OS 18_0 like Mac OS X)')).toBe('Apple TV')
    expect(deviceOf('AppleCoreMedia/1.0.0.21E (iPhone; U; CPU OS 18_1 like Mac OS X; en_us)')).toBe('iPhone (Apple player)')
    expect(deviceOf('TiviMate/5.1.6 (Android 12)')).toBe('TiviMate')
    expect(deviceOf('VLC/3.0.20 LibVLC/3.0.20')).toBe('VLC')
    expect(deviceOf('ExoPlayerLib/2.19.1')).toBe('Android app')
    expect(deviceOf('StalkerWeb-Android/0.4.43 (phone)')).toBe('StalkerWeb Android app')
    expect(deviceOf('StalkerWeb-Android/0.4.43 (TV)')).toBe('StalkerWeb TV app')
    expect(deviceOf('Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/AP1A)')).toBe('Android device')
    expect(deviceOf('Lavf/60.16.100')).toBe('FFmpeg-based player')
    expect(deviceOf(IPHONE)).toBe('iPhone · Chrome (iOS 18.1)')
    expect(deviceOf('')).toBe('Unknown device')
  })
})

describe('ActivityTracker', () => {
  let t, a
  const make = () => { t = 1_000; a = new ActivityTracker({ now: () => t }) }

  it("finds whose a browser's stream is from the call that started it", () => {
    make()
    a.claim({ ip: '10.0.0.5', kind: 'live', id: '1896', viewerId: 'andy', title: 'HGTV 4K' })
    a.touch({ ip: '10.0.0.5', ua: IPHONE, kind: 'live', id: '1896' })()
    expect(a.list()).toEqual([expect.objectContaining({ kind: 'live', id: '1896', viewerId: 'andy', title: 'HGTV 4K', device: 'iPhone · Chrome (iOS 18.1)', ip: '10.0.0.5' })])
  })

  it('keeps an open stream however long, and lets a finished one go after 30 s', () => {
    make()
    const done = a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'live', id: '5' })   // an MPEG-TS pipe, open
    t += 10 * 60_000
    expect(a.list()).toHaveLength(1)
    done()
    t += 20_000
    expect(a.list()).toHaveLength(1)
    t += 15_000
    expect(a.list()).toHaveLength(0)
  })

  it('counts an HLS player once, however many playlists and segments it fetches', () => {
    make()
    for (let i = 0; i < 20; i++) { a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'live', id: '5' })(); t += 2_000 }
    expect(a.list()).toHaveLength(1)
    expect(a.list()[0].startedAt).toBe(1_000)
  })

  it('drops the last channel when the website or app zaps to another', () => {
    make()
    a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'live', id: '5' })()
    a.claim({ ip: '10.0.0.5', ua: DESKTOP, kind: 'live', id: '6', viewerId: 'andy' })   // the player resolving channel 6
    a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'live', id: '6' })()
    expect(a.list().map((s) => s.id)).toEqual(['6'])
  })

  it("keeps an IPTV app's multiview channels, however their requests interleave", () => {
    make()
    for (let i = 0; i < 6; i++) {
      a.touch({ ip: '10.0.0.7', ua: 'TiviMate/5', kind: 'live', id: '5' })(); t += 1_000
      a.touch({ ip: '10.0.0.7', ua: 'TiviMate/5', kind: 'live', id: '6' })(); t += 1_000
    }
    expect(a.list().map((s) => s.id).sort()).toEqual(['5', '6'])
    expect(a.list().every((s) => s.startedAt === 1_000 || s.startedAt === 2_000)).toBe(true)
  })

  it('knows a TV fetching a cast movie, and whose it is', () => {
    make()
    a.claim({ ip: '10.0.0.5', kind: 'vod', id: '100', viewerId: 'andy', cast: true })
    a.touch({ ip: '10.0.0.9', ua: 'Mozilla/5.0 (X11; Linux aarch64) CrKey/1.56', kind: 'vod', id: '100' })()
    expect(a.list()[0]).toMatchObject({ via: 'cast', viewerId: 'andy', device: 'Chromecast' })
  })

  it('forgets what nobody watches even while no one looks at Activity', () => {
    make()
    a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'vod', id: '100' })()
    t += 2 * 60_000
    a.touch({ ip: '10.0.0.6', ua: DESKTOP, kind: 'live', id: '5' })()   // any request prunes, once a minute
    expect(a.size).toBe(1)
  })

  it('keeps two devices on one address apart', () => {
    make()
    a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'live', id: '5' })()
    a.touch({ ip: '10.0.0.5', ua: IPHONE, kind: 'live', id: '6' })()
    expect(a.list()).toHaveLength(2)
  })

  it('gives a cast TV the viewer who cast it, from another address', () => {
    make()
    a.claim({ ip: '10.0.0.5', kind: 'live', id: '42', viewerId: 'kids', cast: true })
    a.touch({ ip: '10.0.0.9', ua: 'CrKey/1.56', kind: 'live', id: '42', via: 'cast' })()
    expect(a.list()[0]).toMatchObject({ viewerId: 'kids', device: 'Chromecast', via: 'cast' })
  })

  it('takes the viewer a link names over any claim', () => {
    make()
    a.claim({ ip: '10.0.0.7', kind: 'live', id: '5', viewerId: 'andy' })
    a.touch({ ip: '10.0.0.7', ua: 'TiviMate/5', kind: 'live', id: '5', viewerId: 'dad', via: 'xtream' })()
    expect(a.list()[0]).toMatchObject({ viewerId: 'dad', via: 'xtream' })
  })

  it('names a movie and its episode from the progress the player saves', () => {
    make()
    a.claim({ ip: '10.0.0.5', kind: 'vod', id: '200:s1:e3', viewerId: 'andy', title: 'Bluey', subtitle: 'E3 · Hammerbarn' })
    a.touch({ ip: '10.0.0.5', ua: DESKTOP, kind: 'vod', id: '200:s1:e3' })()
    expect(a.list()[0]).toMatchObject({ kind: 'vod', title: 'Bluey', subtitle: 'E3 · Hammerbarn', viewerId: 'andy' })
  })
})

describe('GET /api/activity', () => {
  let server, base
  beforeAll(async () => {
    const activity = new ActivityTracker()
    activity.claim({ ip: '10.0.0.5', kind: 'live', id: '1896', viewerId: 'v1' })
    activity.touch({ ip: '10.0.0.5', ua: IPHONE, kind: 'live', id: '1896' })
    activity.touch({ ip: '10.0.0.8', ua: 'VLC/3.0', kind: 'vod', id: '100' })
    const appState = {
      activity,
      activeStreams: 2,
      castHls: { size: 1 },
      client: { getBasePath: () => 'http://portal.example/stalker_portal/' },
      sessionManager: { isAuthenticated: () => true },
      channelManager: { getChannel: (id) => (id === '1896' ? { name: 'HGTV 4K' } : null) },
      catalog: { findMovie: (id) => (id === '100' ? { name: 'Heat' } : null) },
    }
    const viewers = { get: (id) => (id === 'v1' ? { id: 'v1', name: 'Andy', color: '#5b8def', extra: 'not sent' } : null) }
    const downloads = { list: () => [{ status: 'downloading', title: 'E1', seriesTitle: 'Bluey', bytesDownloaded: 50, totalBytes: 200 }, { status: 'done', title: 'Old' }] }
    const app = express()
    app.use('/api/activity', activityRoutes(appState, { viewers, downloads }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })

  it('lists each stream with its viewer, title and device, the portal, and downloads running', async () => {
    const r = await (await fetch(`${base}/api/activity`)).json()
    expect(r.streams).toHaveLength(2)
    expect(r.streams.find((s) => s.id === '1896')).toMatchObject({ title: 'HGTV 4K', viewer: { id: 'v1', name: 'Andy', color: '#5b8def' }, device: 'iPhone · Chrome (iOS 18.1)' })
    expect(r.streams.find((s) => s.id === '1896').viewer.extra).toBeUndefined()
    expect(r.streams.find((s) => s.id === '100')).toMatchObject({ title: 'Heat', viewer: null, device: 'VLC' })
    expect(r.portal).toEqual({ connected: true, host: 'portal.example', openStreams: 2, casting: 1 })
    expect(r.downloads).toEqual([{ title: 'Bluey · E1', percent: 25 }])
  })
})
