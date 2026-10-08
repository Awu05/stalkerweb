import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import proxyModule from '../routes/proxy.js'

// End-to-end through the real proxy router: a fake CDN serves a live HLS
// stream, then starts rejecting its token with 403 the way the stream server
// does once a token expires. The proxy must answer 410 (a 4xx players don't
// retry) rather than 502 (which hls.js retries for ~30s), and must evict the
// channel's cached link so the player's reconnect gets a fresh create_link.

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = (server) => `http://127.0.0.1:${server.address().port}`

let cdn, app, cdnExpired, segGone, errors
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\nseg1.ts?token=abc\n'
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\ntracks-v1a1/mono.m3u8?token=abc\n'

beforeAll(async () => {
  cdn = await listen((req, res) => {
    if (cdnExpired) { res.statusCode = 403; return res.end('Forbidden') }
    if (req.url.startsWith('/index.m3u8')) return res.end(MASTER)
    if (req.url.startsWith('/tracks-v1a1/mono.m3u8')) return res.end(MEDIA)
    if (req.url.startsWith('/tracks-v1a1/seg1.ts')) {
      if (segGone) { res.statusCode = 404; return res.end() }
      return res.end(Buffer.alloc(188 * 4, 0x47))
    }
    res.statusCode = 404; res.end()
  })

  const channel = { uniqueId: '1896', number: 1, name: 'Test', cmd: 'ffmpeg http://x' }
  const appState = {
    client: {
      getBasePath: () => 'http://portal.example.com/c/',
      getHttpClient: () => null,
      streamHeadersFor: () => ({}),
    },
    channelManager: {
      waitForChannel: async () => channel,
      resolveStream: async () => ({ url: `${origin(cdn)}/index.m3u8?token=abc`, type: 'hls' }),
      recordStreamSuccess: () => {},
      recordStreamError: (id) => errors.push(String(id)),
      invalidateResolved: () => {},
      getRawStreamUrl: () => null,
    },
  }
  const e = express()
  e.use('/proxy', proxyModule(appState))
  app = await listen(e)
})

afterAll(() => { cdn?.close(); app?.close() })
beforeEach(() => { cdnExpired = false; segGone = false; errors = [] })

// Walk master → media playlist through the proxy to obtain real signed URLs.
async function signedUrls() {
  const master = await (await fetch(`${origin(app)}/proxy/stream/1896`)).text()
  const mediaUrl = master.split('\n').find((l) => l.includes('/proxy/hls?'))
  const media = await (await fetch(mediaUrl)).text()
  const segUrl = media.split('\n').find((l) => l.includes('/proxy/hls/seg/'))
  return { mediaUrl, segUrl }
}

describe('proxy: expired stream token', () => {
  it('serves the stream normally while the token is valid', async () => {
    const { mediaUrl, segUrl } = await signedUrls()
    expect(mediaUrl).toContain('ch=1896')
    expect((await fetch(segUrl)).status).toBe(200)
    expect(errors).toEqual([])
  })

  it('answers 410 on a 403 playlist and evicts the channel link', async () => {
    const { mediaUrl } = await signedUrls()
    cdnExpired = true

    const res = await fetch(mediaUrl)
    expect(res.status).toBe(410)
    expect(errors).toEqual(['1896'])
  })

  it('answers 410 on a 403 segment and evicts the channel link', async () => {
    const { segUrl } = await signedUrls()
    cdnExpired = true

    const res = await fetch(segUrl)
    expect(res.status).toBe(410)
    expect(errors).toEqual(['1896'])
  })

  it('answers a retryable 5xx on a 404 segment and keeps the link', async () => {
    // The segment has left the live window; the token is still good.
    const { segUrl } = await signedUrls()
    segGone = true

    const res = await fetch(segUrl)
    expect(res.status).toBe(502)
    expect(errors).toEqual([])
  })
})
