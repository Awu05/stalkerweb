import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'node:http'
import { spawnSync } from 'child_process'
import express from 'express'
import proxyModule from '../routes/proxy.js'
import { probeCodecs } from '../stalker/FfmpegService.js'
import { CastHls } from '../stalker/CastHls.js'

// Real FFmpeg through the real proxy, as on the server: a live HLS channel
// (master → media playlist → tokenised segments) behind a fake provider,
// fetched the way this server fetches its own channels — the format probe
// (FFmpeg) and the cast packager (no FFmpeg; FFmpeg only makes the test
// channel here) read /proxy/stream/<id>, whose playlists the proxy has
// rewritten (/proxy/hls?url=…, /proxy/hls/seg/<…>.ts?sig=…&ch=…).
// HGTV 4K's probe read nothing and its cast pulled only the playlist: this is
// that path, end to end.

const hasFfmpeg = (() => {
  // Both: the probe runs ffprobe, the packager ffmpeg.
  try { return ['ffmpeg', 'ffprobe'].every((bin) => spawnSync(bin, ['-version'], { timeout: 5000 }).status === 0) } catch { return false }
})()

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = (server) => `http://127.0.0.1:${server.address().port}`

describe.skipIf(!hasFfmpeg)('FFmpeg through /proxy/stream', () => {
  let root, cdn, app, segs
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-proxy-ffmpeg-'))
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine',
      '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(root, 's%03d.ts'), path.join(root, 'all.m3u8')])
    segs = fs.readFileSync(path.join(root, 'all.m3u8'), 'utf8').split('\n').filter((l) => l.endsWith('.ts'))
    const started = Date.now()
    cdn = await listen((req, res) => {
      if (req.url.startsWith('/live/index.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x240\nvideo.m3u8?token=abc\n')
      }
      if (req.url.startsWith('/live/video.m3u8')) {
        const n = Math.min(segs.length, 4 + Math.floor((Date.now() - started) / 2000))
        const from = Math.max(0, n - 5)
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        return res.end(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`,
          ...segs.slice(from, n).flatMap((s) => ['#EXTINF:2.0,', `${s}?token=abc`]), ''].join('\n'))
      }
      const file = path.join(root, path.basename(req.url.split('?')[0]))
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
      res.setHeader('Content-Type', 'video/mp2t')
      fs.createReadStream(file).pipe(res)
    })
    const channel = { uniqueId: '1896', number: 1, name: 'Test 4K', cmd: 'ffmpeg http://x' }
    const appState = {
      client: { getBasePath: () => 'http://portal.example.com/c/', getHttpClient: () => null, streamHeadersFor: () => ({}) },
      channelManager: {
        waitForChannel: async () => channel,
        resolveStream: async () => ({ url: `${origin(cdn)}/live/index.m3u8?token=abc`, type: 'hls' }),
        recordStreamSuccess: () => {},
        recordStreamError: () => {},
        invalidateResolved: () => {},
        getRawStreamUrl: () => null,
      },
    }
    const e = express()
    e.use('/proxy', proxyModule(appState))
    app = await listen(e)
  }, 60_000)

  afterAll(() => {
    cdn?.closeAllConnections?.(); cdn?.close()
    app?.closeAllConnections?.(); app?.close()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it("reads an HLS channel's format through the proxy (the decode-failure probe)", async () => {
    const probe = await probeCodecs(`${origin(app)}/proxy/stream/1896`)
    expect(probe?.describe).toMatch(/^video h264/)
    expect(probe.video).toBe('h264')
    expect(probe.audio).toBe('aac')
  }, 30_000)

  it('casts an HLS channel read through the proxy', async () => {
    const hls = new CastHls({ inputUrlFor: () => `${origin(app)}/proxy/stream/1896` })
    try {
      const playlist = await hls.playlist('1896')
      const seg = playlist.split('\n').find((l) => l.endsWith('.ts'))
      expect(seg, playlist).toBeTruthy()
      const buf = hls.segment('1896', seg)
      expect(buf.length % 188).toBe(0)
      expect(buf[0]).toBe(0x47)
      expect(hls.codecsOf('1896')).toEqual({ videoType: 0x1b, audioType: 0x0f })
    } finally {
      hls.stopAll()
    }
  }, 40_000)
})
