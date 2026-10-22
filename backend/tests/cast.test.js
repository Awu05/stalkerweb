import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import http from 'http'
import { spawnSync } from 'child_process'
import { setInterval, clearInterval } from 'timers'
import express from 'express'
import { castBase, isLocalHost, vodContentType } from '../lib/castLink.js'
import { CastHls, hlsArgs } from '../stalker/CastHls.js'
import vodModule from '../routes/vod.js'
import streamModule from '../routes/stream.js'

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
  let server, base, stopped, ffmpeg
  beforeAll(async () => {
    stopped = []
    ffmpeg = true
    const appState = {
      shareToken: 'tok',
      castHls: { available: () => ffmpeg, stop: (id) => stopped.push(id) },
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

  it('says when the server has no FFmpeg to cast live TV with', async () => {
    ffmpeg = false
    try { expect((await get('/api/stream/42/cast')).status).toBe(415) } finally { ffmpeg = true }
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
  let root, hls, procs, clock
  const fakeSpawn = (cmd, args) => {
    const p = new EventEmitter()
    p.args = args
    p.stderr = new EventEmitter()
    p.killed = false
    p.kill = () => { p.killed = true; p.emit('close', null) }
    procs.push(p)
    return p
  }
  const make = (o = {}) => new CastHls({ root, inputUrlFor: (id) => `http://127.0.0.1:1/proxy/stream/${id}`, spawn: fakeSpawn, now: () => clock, pollMs: 5, ...o })
  const dirOf = (id) => path.join(root, id)
  const writePlaylist = (id) => fs.writeFileSync(path.join(dirOf(id), 'index.m3u8'), '#EXTM3U\n')

  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cast-')) })
  afterEach(() => { hls?.stopAll(); procs = [] })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  procs = []
  clock = 0

  it('re-wraps the channel from this server, copying its streams into HLS', () => {
    const a = hlsArgs('http://127.0.0.1:1/proxy/stream/5', '/tmp/x')
    expect(a).toContain('copy')
    // Never -reconnect_at_eof: an HLS playlist ends after every download (it looped on it).
    expect(a).not.toContain('-reconnect_at_eof')
    // A restarted session numbers on from the clock.
    expect(a[a.indexOf('-hls_start_number_source') + 1]).toBe('datetime')
    expect(a[a.indexOf('-i') + 1]).toBe('http://127.0.0.1:1/proxy/stream/5')
    expect(a.at(-1)).toBe(path.join('/tmp/x', 'index.m3u8'))
  })

  it('starts a channel once, and answers with its playlist when FFmpeg has written it', async () => {
    hls = make()
    const first = hls.playlist('5')
    const second = hls.playlist('5')
    expect(procs).toHaveLength(1)
    writePlaylist('5')
    expect(await first).toBe(path.join(dirOf('5'), 'index.m3u8'))
    expect(await second).toBe(path.join(dirOf('5'), 'index.m3u8'))
  })

  it('serves only its own segments', async () => {
    hls = make()
    const p = hls.playlist('6'); writePlaylist('6'); await p
    fs.writeFileSync(path.join(dirOf('6'), 'seg00001.ts'), 'x')
    expect(hls.segment('6', 'seg00001.ts')).toBe(path.join(dirOf('6'), 'seg00001.ts'))
    // Numbered by the clock, as FFmpeg does here.
    fs.writeFileSync(path.join(dirOf('6'), 'seg20261021031523.ts'), 'x')
    expect(hls.segment('6', 'seg20261021031523.ts')).toBe(path.join(dirOf('6'), 'seg20261021031523.ts'))
    expect(hls.segment('6', '../../etc/passwd')).toBeNull()
    expect(hls.segment('6', 'index.m3u8')).toBeNull()
    expect(hls.segment('9', 'seg00001.ts')).toBeNull()
  })

  it('reopens a source that ended (an MPEG-TS restart) while the TV watches, carrying the playlist on', async () => {
    hls = make()
    const p = hls.playlist('21'); writePlaylist('21'); await p
    procs[0].emit('close', 0)
    expect(procs).toHaveLength(2)
    expect(procs[1].args.join(' ')).toContain('append_list+discont_start')
    expect(hls.size).toBe(1)
    expect(fs.existsSync(dirOf('21'))).toBe(true)
  })

  it('gives up on a source that keeps ending, or that FFmpeg fails on', async () => {
    hls = make({ maxRestartsPerMinute: 2 })
    const p = hls.playlist('22'); writePlaylist('22'); await p
    procs[0].emit('close', 0)
    procs[1].emit('close', 0)
    procs[2].emit('close', 0)
    expect(procs).toHaveLength(3)
    expect(hls.size).toBe(0)
    hls.playlist('23').catch(() => {})
    procs[3].emit('close', 1)
    expect(procs).toHaveLength(4)
  })

  it("reads this server's stream with its own user agent", () => {
    const a = hlsArgs('http://x', '/tmp/x', { userAgent: 'StalkerWeb-internal/abc' })
    expect(a[a.indexOf('-user_agent') + 1]).toBe('StalkerWeb-internal/abc')
  })

  it('stops a channel when asked, and only that one', async () => {
    hls = make()
    hls.playlist('11').catch(() => {})
    hls.playlist('12').catch(() => {})
    hls.stop('11')
    expect(procs[0].killed).toBe(true)
    expect(procs[1].killed).toBe(false)
    expect(hls.size).toBe(1)
  })

  it('stops a channel no one asks for, and tidies its folder', async () => {
    hls = make({ idleMs: 1000 })
    const p = hls.playlist('7'); writePlaylist('7'); await p
    clock += 1500
    hls._sweep()
    expect(procs[0].killed).toBe(true)
    expect(hls.size).toBe(0)
    expect(fs.existsSync(dirOf('7'))).toBe(false)
  })

  it('fails the request when FFmpeg gives up, and starts again next time', async () => {
    hls = make()
    const p = hls.playlist('8')
    procs[0].emit('close', 1)
    await expect(p).rejects.toThrow('stopped')
    hls.playlist('8').catch(() => {})
    expect(procs).toHaveLength(2)
  })

  it('makes room by stopping the channel used longest ago', async () => {
    hls = make({ maxSessions: 2 })
    hls.playlist('1').catch(() => {}); clock += 10
    hls.playlist('2').catch(() => {}); clock += 10
    hls.playlist('1').catch(() => {}); clock += 10   // 1 used again: 2 is the oldest
    hls.playlist('3').catch(() => {})
    expect(procs[1].killed).toBe(true)
    expect(procs[0].killed).toBe(false)
    expect(hls.size).toBe(2)
  })

  it('gives up on a channel that never starts', async () => {
    let t = 0
    hls = make({ startTimeoutMs: 50, now: () => (t += 20) })
    await expect(hls.playlist('4')).rejects.toThrow('too long')
    expect(procs[0].killed).toBe(true)
  })
})

// With a real FFmpeg (CI, the Docker image): a generated MPEG-TS stream, served
// over HTTP as /proxy/stream would, comes out as an HLS playlist and segments.
const hasFfmpeg = (() => {
  try { return spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0 } catch { return false }
})()

describe.skipIf(!hasFfmpeg)('CastHls with FFmpeg', () => {
  it('reads an HLS channel at its own pace — not its playlist over and over', async () => {
    // A live HLS source, as /proxy/stream serves an HLS channel: a playlist of
    // 2 s segments that grows with the clock.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cast-hls-'))
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine',
      '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(root, 's%03d.ts'), path.join(root, 'all.m3u8')])
    const segs = fs.readFileSync(path.join(root, 'all.m3u8'), 'utf8').split('\n').filter((l) => l.endsWith('.ts'))
    const started = Date.now()
    let playlistHits = 0
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/live.m3u8')) {
        playlistHits++
        const n = Math.min(segs.length, 3 + Math.floor((Date.now() - started) / 2000))
        const from = Math.max(0, n - 5)
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        return res.end(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`,
          ...segs.slice(from, n).flatMap((s) => ['#EXTINF:2.0,', `/${s}`]), ''].join('\n'))
      }
      const file = path.join(root, path.basename(req.url))
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
      res.setHeader('Content-Type', 'video/mp2t')
      fs.createReadStream(file).pipe(res)
    })
    await new Promise((r) => server.listen(0, r))
    const hls = new CastHls({ root: path.join(root, 'cast'), inputUrlFor: () => `http://127.0.0.1:${server.address().port}/live.m3u8` })
    try {
      const playlist = fs.readFileSync(await hls.playlist('2'), 'utf8')
      expect(playlist).toContain('#EXTM3U')
      await new Promise((r) => setTimeout(r, 6000))
      const secs = (Date.now() - started) / 1000
      // FFmpeg reloads a live playlist about once a segment (every ~2 s); the loop made it ~10 a second.
      expect(playlistHits / secs).toBeLessThan(2)
    } finally {
      hls.stopAll()
      server.closeAllConnections(); server.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('turns a live MPEG-TS stream into HLS', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cast-real-'))
    const src = path.join(root, 'src.ts')
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine',
      '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', src])
    // Sent a little at a time, as a live channel comes (all at once, FFmpeg would finish and tidy up).
    const data = fs.readFileSync(src)
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'video/mp2t')
      let at = 0
      const tick = setInterval(() => {
        if (at >= data.length || res.destroyed) { clearInterval(tick); return res.end() }
        res.write(data.subarray(at, at += 32 * 1024))
      }, 100)
      req.on('close', () => clearInterval(tick))
    })
    await new Promise((r) => server.listen(0, r))
    const hls = new CastHls({ root: path.join(root, 'cast'), inputUrlFor: () => `http://127.0.0.1:${server.address().port}/stream` })
    try {
      const playlist = fs.readFileSync(await hls.playlist('1'), 'utf8')
      expect(playlist).toContain('#EXTM3U')
      const seg = playlist.split('\n').find((l) => l.endsWith('.ts'))
      expect(hls.segment('1', seg)).toBeTruthy()
    } finally {
      hls.stopAll()
      server.closeAllConnections(); server.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
