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

beforeAll(async () => {
  cdn = await listen((req, res) => {
    ports.push({ url: req.url, port: req.socket.remotePort })
    if (req.url.startsWith('/live/index.m3u8')) return res.end(MASTER)
    if (req.url.startsWith('/live/tracks-v1a1/mono.m3u8')) return res.end(MEDIA)
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
  e.use('/proxy', proxyModule(appState))
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
})
