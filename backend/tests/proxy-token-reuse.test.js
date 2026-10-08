import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import proxyModule from '../routes/proxy.js'
import ChannelManager from '../stalker/ChannelManager.js'

// Stream servers commonly allow one live token per account: every create_link
// mints a new token and the previous one starts answering 403. Many clients
// fetch the channel URL twice in quick succession (a probe, then the real
// open — Jellyfin/ffprobe, VLC, native players), so if each /proxy/stream
// fetch calls create_link again, the second fetch kills the token the first
// one handed out and playback dies on its first sub-playlist request.

const listen = (handler, host = '127.0.0.1') => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, host, () => resolve(server))
})
const origin = (server) => `http://${server.address().address}:${server.address().port}`

let cdn, app, cm, validToken, createLinkCalls

beforeAll(async () => {
  // Not 127.0.0.1: ChannelManager rewrites loopback stream hosts to the portal.
  cdn = await listen((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.searchParams.get('token') !== validToken) { res.statusCode = 403; return res.end('Forbidden') }
    if (u.pathname.endsWith('/index.m3u8')) {
      return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\ntracks-v1a1/mono.m3u8?token=${validToken}\n`)
    }
    if (u.pathname.endsWith('/mono.m3u8')) {
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6,\nseg1.ts?token=${validToken}\n`)
    }
    res.end(Buffer.alloc(188, 0x47))
  }, '127.0.0.2')

  let seq = 0
  const client = {
    getBasePath: () => 'http://portal.example/stalker_portal/',
    getHttpClient: () => null,
    streamHeadersFor: () => ({}),
    itvCreateLink: async () => {
      createLinkCalls++
      validToken = `T${++seq}` // older tokens are now rejected
      return { js: { cmd: `ffrt ${origin(cdn)}/live/index.m3u8?token=${validToken}` } }
    },
  }
  cm = new ChannelManager(client)
  cm._parseChannels({ js: { data: [{ id: '16801', name: 'News', number: '142', cmd: 'ffrt http://localhost/ch/76604' }] } })

  const e = express()
  e.use('/proxy', proxyModule({ client, channelManager: cm }))
  app = await listen(e)
})

afterAll(() => { cdn?.close(); app?.close() })
beforeEach(() => {
  createLinkCalls = 0
  cm._resolvedCache.clear()
})

const subPlaylistUrl = (master) => master.split('\n').find((l) => l.includes('/proxy/hls?'))

describe('proxy: stream link reuse', () => {
  it('keeps the first token valid when a client fetches the channel twice', async () => {
    const first  = await (await fetch(`${origin(app)}/proxy/stream/16801`)).text()
    const second = await (await fetch(`${origin(app)}/proxy/stream/16801`)).text()

    // The player follows the playlist it got from the FIRST fetch.
    const res = await fetch(subPlaylistUrl(first))
    expect(res.status).toBe(200)
    expect(createLinkCalls).toBe(1)
    expect(second).toContain('/proxy/hls?')
  })

  it('shares one create_link between simultaneous fetches', async () => {
    const [a, b] = await Promise.all([
      fetch(`${origin(app)}/proxy/stream/16801`).then((r) => r.text()),
      fetch(`${origin(app)}/proxy/stream/16801`).then((r) => r.text()),
    ])
    expect(createLinkCalls).toBe(1)
    expect((await fetch(subPlaylistUrl(a))).status).toBe(200)
    expect((await fetch(subPlaylistUrl(b))).status).toBe(200)
  })

  it('still mints a fresh token once the stream server rejects the cached one', async () => {
    const first = await (await fetch(`${origin(app)}/proxy/stream/16801`)).text()
    validToken = 'expired-elsewhere' // the token dies (expiry, another device…)

    expect((await fetch(subPlaylistUrl(first))).status).toBe(410)

    // The 410 evicted the cached link, so the reconnect gets a new token.
    const again = await (await fetch(`${origin(app)}/proxy/stream/16801`)).text()
    expect(createLinkCalls).toBe(2)
    expect((await fetch(subPlaylistUrl(again))).status).toBe(200)
  })
})
