import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import express from 'express'
import proxyModule from '../routes/proxy.js'

// End-to-end through the real proxy router with the live buffer on: the proxy
// polls the source's media playlist itself, downloads each segment once, and
// players get the buffer's playlist and segments from memory.

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = (server) => `http://127.0.0.1:${server.address().port}`

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\ntracks-v1a1/mono.m3u8?token=abc\n'
const media = (from, n) => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:' + from + '\n' +
  Array.from({ length: n }, (_, i) => `#EXTINF:6.000,\nseg${from + i}.ts?token=abc`).join('\n') + '\n'

let cdn, app
const hits = {}   // path → requests the source saw

beforeAll(async () => {
  cdn = await listen((req, res) => {
    const path = req.url.split('?')[0]
    hits[path] = (hits[path] ?? 0) + 1
    if (path === '/live/index.m3u8') return res.end(MASTER)
    if (path === '/live/tracks-v1a1/mono.m3u8') return res.end(media(100, 8))
    const m = /seg(\d+)\.ts$/.exec(path)
    if (m) return res.end(Buffer.alloc(188 * 2, Number(m[1]) % 256))
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
    getLiveBufferSeconds: () => 30,
  }
  const e = express()
  e.use('/proxy', proxyModule(appState, { segmentRetryMs: [10, 10] }))
  app = await listen(e)
})

afterAll(() => { cdn?.close(); app?.close() })

describe('live buffer through the proxy', () => {
  it("serves the buffer's playlist, and segments from memory", async () => {
    const master = await (await fetch(`${origin(app)}/proxy/stream/1896`)).text()
    const mediaUrl = master.split('\n').find((l) => l.includes('/proxy/hls?'))
    const pl = await (await fetch(mediaUrl)).text()

    // 48 s listed: the oldest 18 s released at once, the newest 30 s held.
    const segs = pl.split('\n').filter((l) => l.includes('/proxy/hls/seg/'))
    expect(segs).toHaveLength(3)
    expect(pl).toContain('#EXT-X-MEDIA-SEQUENCE:0')

    // Wait for the held segments to download too.
    for (let i = 0; i < 50 && !hits['/live/tracks-v1a1/seg107.ts']; i++) await new Promise((r) => setTimeout(r, 20))
    for (const n of [100, 101, 102, 103, 104, 105, 106, 107]) expect(hits[`/live/tracks-v1a1/seg${n}.ts`], `seg${n}`).toBe(1)

    // Players' segment requests come from memory: the source sees no more.
    for (const [i, s] of segs.entries()) {
      const r = await fetch(s)
      expect(r.status).toBe(200)
      expect(new Uint8Array(await r.arrayBuffer())[0]).toBe(100 + i)
    }
    for (const n of [100, 101, 102]) expect(hits[`/live/tracks-v1a1/seg${n}.ts`]).toBe(1)
  })
})
