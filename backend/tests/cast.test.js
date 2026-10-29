import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import os from 'os'
import http from 'http'
import { setInterval, clearInterval } from 'timers'
import express from 'express'
import { castBase, isLocalHost, vodContentType } from '../lib/castLink.js'
import { CastHls } from '../stalker/CastHls.js'
import vodModule from '../routes/vod.js'
import streamModule from '../routes/stream.js'
import proxyModule from '../routes/proxy.js'
import { readSelfStream } from '../stalker/selfStreamReader.js'
import { makeTs, startsWithKeyframe } from './helpers/makeTs.js'

// A playlist's pieces, by name.
const pieces = (playlist) => playlist.split('\n').filter((l) => l.endsWith('.ts'))

describe('cast links', () => {
  const req = (host, protocol = 'http') => ({ protocol, get: (h) => (h === 'host' ? host : undefined) })

  it('carry the share token, never the key, and the address the app was opened on', () => {
    expect(castBase(req('192.168.1.5:8983'), 'tok')).toBe('http://192.168.1.5:8983/k/tok')
    expect(castBase(req('tv.example.com', 'https'), null)).toBe('https://tv.example.com')
  })

  it('know an address only this machine can reach', () => {
    for (const h of ['localhost:5173', '127.0.0.1:8983', '[::1]:8983', 'app.localhost']) expect(isLocalHost(h)).toBe(true)
    for (const h of ['192.168.1.5:8983', 'tv.example.com', '10.0.0.2']) expect(isLocalHost(h)).toBe(false)
  })

  it('name a movie file by its extension', () => {
    expect(vodContentType('.mp4')).toBe('video/mp4')
    expect(vodContentType('MKV')).toBe('video/x-matroska')
    expect(vodContentType('.weird')).toBe('video/mp4')
  })
})

describe('/api/stream/:id/cast and /api/vod/cast', () => {
  let server, base, stopped
  beforeAll(async () => {
    stopped = []
    const appState = {
      shareToken: 'tok',
      castHls: { stop: (id) => stopped.push(id) },   // no FFmpeg needed: nothing asks whether it's there
      sessionManager: { isAuthenticated: () => true },
      vodManager: { getStreamUrl: async (id) => (id === 'hls' ? 'http://cdn/x/index.m3u8?t=1' : 'http://cdn/x/movie.mkv') },
    }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: os.tmpdir() }, {}))
    app.use('/api/stream', streamModule(appState, {}))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })
  // http.request: fetch won't send a Host of our choosing.
  const get = (p, host) => new Promise((resolve, reject) => {
    http.get(base + p, host ? { headers: { Host: host } } : {}, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }))
    }).on('error', reject)
  })

  it('gives a live channel as HLS under the share token', async () => {
    const r = await get('/api/stream/42/cast', '192.168.1.5:8983')
    expect(r.body).toEqual({ url: 'http://192.168.1.5:8983/k/tok/proxy/cast/live/42/index.m3u8', contentType: 'application/x-mpegURL', live: true, reachable: true })
  })

  it('says when the address is only this machine', async () => {
    expect((await get('/api/stream/42/cast')).body.reachable).toBe(false)
  })

  it("stops a channel's cast stream when the sender says so", async () => {
    const r = await new Promise((resolve, reject) => {
      http.request(base + '/api/stream/42/cast', { method: 'DELETE' }, resolve).on('error', reject).end()
    })
    expect(r.statusCode).toBe(204)
    expect(stopped).toEqual(['42'])
  })

  it('refuses a channel id that is not a number', async () => {
    expect((await get('/api/stream/abc/cast')).status).toBe(400)
  })

  it('gives a movie as the file it is, an HLS one as HLS', async () => {
    const mkv = await get('/api/vod/cast?videoId=7&cmd=x', 'tv.example.com')
    expect(mkv.body).toMatchObject({ url: 'http://tv.example.com/k/tok/proxy/vod/stream.mkv?videoId=7&cmd=x', contentType: 'video/x-matroska', live: false })
    const hls = await get('/api/vod/cast?videoId=hls', 'tv.example.com')
    expect(hls.body).toMatchObject({ url: 'http://tv.example.com/k/tok/proxy/vod/stream.m3u8?videoId=hls', contentType: 'application/x-mpegURL' })
  })

  it('needs a videoId', async () => {
    expect((await get('/api/vod/cast')).status).toBe(400)
  })
})

describe('CastHls', () => {
  let hls, readers, clock
  // Stands in for readSelfStream: the test feeds each session's bytes itself.
  const fakeReader = (url, o) => {
    readers.push({ url, ...o })
    return new Promise((resolve) => o.signal.addEventListener('abort', resolve))
  }
  const make = (o = {}) => new CastHls({ inputUrlFor: (id) => `http://127.0.0.1:1/proxy/stream/${id}`, userAgent: 'StalkerWeb-internal/abc',
    reader: fakeReader, now: () => clock, ...o })

  beforeEach(() => { readers = []; clock = 0 })
  afterEach(() => { hls?.stopAll() })

  it('serves a playlist and its pieces for a channel while it is cast', async () => {
    hls = make()
    const first = hls.playlist('5')
    const second = hls.playlist('5')
    expect(readers).toHaveLength(1)
    expect(readers[0].url).toBe('http://127.0.0.1:1/proxy/stream/5')
    expect(readers[0].userAgent).toBe('StalkerWeb-internal/abc')
    // Waits for the first piece: the bytes come after the TV asked.
    await new Promise((r) => setTimeout(r, 10))
    readers[0].onData(makeTs({ seconds: 12 }))
    const playlist = await first
    expect(await second).toBe(playlist)
    expect(playlist).toContain('#EXTM3U')
    const names = pieces(playlist)
    expect(names.length).toBeGreaterThanOrEqual(2)
    const buf = hls.segment('5', names[0])
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(startsWithKeyframe(buf)).toBe(true)
    expect(hls.segment('5', '../../etc/passwd')).toBeNull()
    expect(hls.segment('5', 'index.m3u8')).toBeNull()
    expect(hls.segment('5', 'seg999.ts')).toBeNull()
    expect(hls.segment('9', names[0])).toBeNull()
    expect(hls.codecsOf('5')).toEqual({ videoType: 0x1b, audioType: 0x0f })
    expect(hls.codecsOf('9')).toBeNull()
    expect(hls.available()).toBe(true)
  })

  it('lists as many pieces as it is told to (Solo keeps fewer)', async () => {
    hls = make({ windowSize: 2 })
    const p = hls.playlist('6')
    readers[0].onData(makeTs({ seconds: 30 }))
    expect(pieces(await p)).toHaveLength(2)
  })

  it('keeps the TV playing across a source restart (EXT-X-DISCONTINUITY, pieces keep coming)', async () => {
    hls = make()
    const p = hls.playlist('21')
    readers[0].onData(makeTs({ seconds: 12 }))
    const before = pieces(await p)
    // The source dropped and came back with other timestamps.
    readers[0].onBreak()
    readers[0].onData(makeTs({ seconds: 12, startPts: 90000 * 3600 }))
    const after = await hls.playlist('21')
    expect(after).toContain('#EXT-X-DISCONTINUITY')
    const names = pieces(after)
    expect(names.length).toBeGreaterThan(before.length)
    expect(names.slice(0, before.length)).toEqual(before)   // the TV's pieces stay, numbered on
    expect(startsWithKeyframe(hls.segment('21', names.at(-1)))).toBe(true)
    expect(readers).toHaveLength(1)
    expect(hls.size).toBe(1)
  })

  it('stops a session no one asked for in idleMs', async () => {
    hls = make({ idleMs: 1000 })
    const p = hls.playlist('7')
    readers[0].onData(makeTs({ seconds: 12 }))
    const name = pieces(await p)[0]
    clock += 500
    hls._sweep()
    expect(hls.size).toBe(1)
    expect(hls.segment('7', name)).toBeTruthy()   // asked again: still watched
    clock += 1500
    hls._sweep()
    expect(hls.size).toBe(0)
    expect(readers[0].signal.aborted).toBe(true)
    expect(hls.segment('7', name)).toBeNull()
    expect(hls.codecsOf('7')).toBeNull()
    // The next request starts it again.
    hls.playlist('7').catch(() => {})
    expect(readers).toHaveLength(2)
  })

  it('starts no more than maxSessions', async () => {
    hls = make({ maxSessions: 2 })
    hls.playlist('1').catch(() => {}); clock += 10
    hls.playlist('2').catch(() => {}); clock += 10
    hls.playlist('1').catch(() => {}); clock += 10   // 1 used again: 2 is the oldest
    hls.playlist('3').catch(() => {})
    expect(readers.map((r) => r.url.split('/').pop())).toEqual(['1', '2', '3'])
    expect(readers[1].signal.aborted).toBe(true)
    expect(readers[0].signal.aborted).toBe(false)
    expect(readers[2].signal.aborted).toBe(false)
    expect(hls.size).toBe(2)
  })

  it('stops a channel when asked, and only that one', async () => {
    hls = make()
    const p = hls.playlist('11')
    hls.playlist('12').catch(() => {})
    hls.stop('11')
    await expect(p).rejects.toThrow('stopped')
    expect(readers[0].signal.aborted).toBe(true)
    expect(readers[1].signal.aborted).toBe(false)
    expect(hls.size).toBe(1)
  })

  it('gives up on a channel that never starts', async () => {
    hls = make({ startTimeoutMs: 50 })
    await expect(hls.playlist('4')).rejects.toThrow('too long')
    expect(readers[0].signal.aborted).toBe(true)
    expect(hls.size).toBe(0)
  })

  it('ends the session when its reader fails, and starts again next time', async () => {
    let fail
    hls = make({ reader: (url, o) => { readers.push({ url, ...o }); return new Promise((_, reject) => { fail = reject }) } })
    const p = hls.playlist('8')
    fail(new Error('boom'))
    await expect(p).rejects.toThrow('stopped')
    expect(hls.size).toBe(0)
    hls.playlist('8').catch(() => {})
    expect(readers).toHaveLength(2)
  })
})

// The real reader over HTTP, as this server reads its own /proxy/stream: no
// FFmpeg anywhere.
describe('CastHls over HTTP', () => {
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

  it('turns a live MPEG-TS stream into HLS', async () => {
    const data = makeTs({ seconds: 60 })
    // Sent a little at a time, as a live channel comes.
    const server = await listen((req, res) => {
      res.setHeader('Content-Type', 'video/mp2t')
      let at = 0
      const tick = setInterval(() => {
        if (at >= data.length || res.destroyed) { clearInterval(tick); return res.end() }
        res.write(data.subarray(at, at += 64 * 1024))
      }, 20)
      req.on('close', () => clearInterval(tick))
    })
    const hls = new CastHls({ inputUrlFor: () => `http://127.0.0.1:${server.address().port}/proxy/stream/1` })
    try {
      const playlist = await hls.playlist('1')
      expect(playlist).toContain('#EXTM3U')
      expect(startsWithKeyframe(hls.segment('1', pieces(playlist)[0]))).toBe(true)
    } finally {
      hls.stopAll()
      server.closeAllConnections(); server.close()
    }
  }, 20_000)

  it('reads an HLS channel at its own pace — not its playlist over and over', async () => {
    // A live HLS source, as /proxy/stream serves an HLS channel: 2 s segments,
    // a playlist that grows with the clock.
    const segs = Array.from({ length: 30 }, (_, i) => makeTs({ seconds: 2, startPts: i * 2 * 90000 }))
    const started = Date.now()
    let playlistHits = 0
    const server = await listen((req, res) => {
      if (req.url.startsWith('/live.m3u8')) {
        playlistHits++
        const n = Math.min(segs.length, 3 + Math.floor((Date.now() - started) / 2000))
        const from = Math.max(0, n - 5)
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        return res.end(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`,
          ...segs.slice(from, n).flatMap((_, i) => ['#EXTINF:2.0,', `/s${from + i}.ts`]), ''].join('\n'))
      }
      const m = /^\/s(\d+)\.ts$/.exec(req.url)
      if (!m || !segs[m[1]]) { res.statusCode = 404; return res.end() }
      res.setHeader('Content-Type', 'video/mp2t')
      res.end(segs[m[1]])
    })
    const hls = new CastHls({ inputUrlFor: () => `http://127.0.0.1:${server.address().port}/live.m3u8` })
    try {
      expect(await hls.playlist('2')).toContain('#EXTM3U')
      await new Promise((r) => setTimeout(r, 3000))
      const secs = (Date.now() - started) / 1000
      expect(playlistHits / secs).toBeLessThan(2)
    } finally {
      hls.stopAll()
      server.closeAllConnections(); server.close()
    }
  }, 20_000)
})

// /proxy/cast/live/<id>/index.m3u8 over HTTP, the real reader on a fake
// /proxy/stream: an HLS channel the segmenter can't cut (encrypted, fMP4) is
// sent to the channel's own HLS, under the token the TV came in on.
describe('the cast playlist route', () => {
  let server, base, hls
  const playlistFor = {
    42: '#EXT-X-KEY:METHOD=AES-128,URI="/key"',
    43: '#EXT-X-MAP:URI="/init.mp4"',
    44: null,
  }
  const fetchImpl = async (url) => {
    const u = new URL(url)
    const seg = /^\/seg\/(\d+)\.ts$/.exec(u.pathname)
    if (seg) return new globalThis.Response(makeTs({ seconds: 2, startPts: Number(seg[1]) * 180000 }), { headers: { 'Content-Type': 'video/mp2t' } })
    const id = u.pathname.split('/').pop()
    const tag = playlistFor[id]
    return new globalThis.Response(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', ...(tag ? [tag] : []),
      ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:2.0,', `/seg/${i}.ts`]), ''].join('\n'), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
  }
  beforeAll(async () => {
    hls = new CastHls({ inputUrlFor: (id) => `http://127.0.0.1:1/proxy/stream/${id}`, reader: (url, o) => readSelfStream(url, { ...o, fetchImpl, pollMs: 50 }) })
    const app = express()
    // As lib/access.js does for a /k/<token> link.
    app.use((req, _res, next) => {
      if (req.url.startsWith('/k/tok/')) { req.accessPrefix = '/k/tok'; req.url = req.url.slice('/k/tok'.length) }
      next()
    })
    app.use('/proxy', proxyModule({ castHls: hls }))
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => { hls.stopAll(); server.closeAllConnections(); server.close() })
  const get = (p) => new Promise((resolve, reject) => {
    http.get(base + p, (r) => {
      const parts = []
      r.on('data', (c) => parts.push(c))
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(parts) }))
    }).on('error', reject)
  })

  it('sends the TV to the channel itself when its HLS is encrypted', async () => {
    const r = await get('/k/tok/proxy/cast/live/42/index.m3u8')
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(`${base}/k/tok/proxy/stream/42`)
    // Asked again: still passed through, nothing cut.
    expect((await get('/k/tok/proxy/cast/live/42/index.m3u8')).status).toBe(302)
    expect(hls.codecsOf('42')).toBeNull()
  })

  it('does the same for an fMP4 channel', async () => {
    const r = await get('/k/tok/proxy/cast/live/43/index.m3u8')
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(`${base}/k/tok/proxy/stream/43`)
  })

  it('still cuts a plain TS channel into pieces', async () => {
    const r = await get('/k/tok/proxy/cast/live/44/index.m3u8')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/mpegurl/)
    const name = pieces(r.body.toString())[0]
    const seg = await get(`/k/tok/proxy/cast/live/44/${name}`)
    expect(seg.status).toBe(200)
    expect(seg.headers['content-type']).toMatch(/video\/mp2t/)
    expect(seg.headers.etag).toBeUndefined()   // not hashed for one
    expect(Number(seg.headers['content-length'])).toBe(seg.body.length)
    expect(startsWithKeyframe(seg.body)).toBe(true)
  })
})
