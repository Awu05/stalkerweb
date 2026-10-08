import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import express from 'express'
import proxyModule from '../routes/proxy.js'

// End-to-end through the real proxy router: a fake Flussonic-style server
// keeps each minute's segments in their own directory. Every request a live
// channel makes — master, media playlist, segments from two different minutes
// — must reach the server over one connection, like a set-top box. (A new
// connection per directory can land on another server behind a load balancer,
// one that doesn't have the files the playlist lists.)

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = (server) => `http://127.0.0.1:${server.address().port}`

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\ntracks-v1a1/mono.m3u8?token=abc\n'
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n' +
  '#EXTINF:6.000,\n2026/10/08/21/57/54-06000.ts?token=abc\n' +
  '#EXTINF:6.000,\n2026/10/08/21/58/00-06000.ts?token=abc\n'

let cdn, app
const ports = []   // client port of each request the server saw
const missing = {} // segment path → how many more times to answer 404

beforeAll(async () => {
  cdn = await listen((req, res) => {
    ports.push({ url: req.url, port: req.socket.remotePort })
    if (req.url.startsWith('/live/index.m3u8')) return res.end(MASTER)
    if (req.url.startsWith('/live/tracks-v1a1/mono.m3u8')) return res.end(MEDIA)
    const path = req.url.split('?')[0]
    if (missing[path] > 0) { missing[path]--; res.statusCode = 404; return res.end('not found') }
    if (req.url.includes('/2026/10/08/')) return res.end(Buffer.alloc(188 * 4, 0x47))
    res.statusCode = 404
    res.end()
  })
  const channel = { uniqueId: '1896', number: 1, name: 'Test', cmd: 'ffmpeg http://x' }
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
  e.use('/proxy', proxyModule(appState, { segmentRetryMs: [20, 20] }))
  app = await listen(e)
})

afterAll(() => { cdn?.close(); app?.close() })

describe('upstream connections', () => {
  it("keeps a live channel's playlists and segments on one connection", async () => {
    const master = await (await fetch(`${origin(app)}/proxy/stream/1896`)).text()
    const mediaUrl = master.split('\n').find((l) => l.includes('/proxy/hls?'))
    const media = await (await fetch(mediaUrl)).text()
    const segs = media.split('\n').filter((l) => l.includes('/proxy/hls/seg/'))
    expect(segs).toHaveLength(2)
    for (const s of segs) expect((await fetch(s)).status).toBe(200)
    await (await fetch(mediaUrl)).text()   // a reload

    expect(ports.map((p) => p.url.split('?')[0])).toEqual([
      '/live/index.m3u8', '/live/tracks-v1a1/mono.m3u8',
      '/live/tracks-v1a1/2026/10/08/21/57/54-06000.ts', '/live/tracks-v1a1/2026/10/08/21/58/00-06000.ts',
      '/live/tracks-v1a1/mono.m3u8',
    ])
    expect(new Set(ports.map((p) => p.port)).size).toBe(1)
  })

  it('asks again for a segment the server listed but is missing for a moment', async () => {
    const master = await (await fetch(`${origin(app)}/proxy/stream/1896`)).text()
    const mediaUrl = master.split('\n').find((l) => l.includes('/proxy/hls?'))
    const segs = (await (await fetch(mediaUrl)).text()).split('\n').filter((l) => l.includes('/proxy/hls/seg/'))
    ports.length = 0

    missing['/live/tracks-v1a1/2026/10/08/21/57/54-06000.ts'] = 2   // ready on the third try
    const ok = await fetch(segs[0])
    expect(ok.status).toBe(200)
    expect((await ok.arrayBuffer()).byteLength).toBe(188 * 4)

    missing['/live/tracks-v1a1/2026/10/08/21/58/00-06000.ts'] = 5   // never there
    expect((await fetch(segs[1])).status).toBe(502)

    expect(ports.map((p) => p.url.split('?')[0].split('/').slice(-2).join('/'))).toEqual([
      '57/54-06000.ts', '57/54-06000.ts', '57/54-06000.ts',   // two 404s, then served
      '58/00-06000.ts', '58/00-06000.ts', '58/00-06000.ts',   // three 404s, given up
    ])
    // The 404s were read off the connection, not dropped with it.
    expect(new Set(ports.map((p) => p.port)).size).toBe(1)
  })
})
