import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import proxyModule from '../routes/proxy.js'
import { loadProxySecret } from '../lib/proxySecret.js'

// The key that signs stream links outlives a restart (lib/proxySecret.js):
// a player open across one keeps its links instead of getting 403s.

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = (server) => `http://127.0.0.1:${server.address().port}`

describe('loadProxySecret', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-secret-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('makes a key on first use and gives the same one back after a restart', () => {
    const first = loadProxySecret(dir)
    expect(first.length).toBe(32)
    expect(fs.readFileSync(path.join(dir, 'proxy-secret'), 'utf8')).toBe(first.toString('hex'))
    expect(loadProxySecret(dir).equals(first)).toBe(true)
  })

  it('replaces a damaged key file', () => {
    fs.writeFileSync(path.join(dir, 'proxy-secret'), 'not a key')
    const key = loadProxySecret(dir)
    expect(key.length).toBe(32)
    expect(loadProxySecret(dir).equals(key)).toBe(true)
  })

  it('makes the data folder when it is not there yet', () => {
    const inner = path.join(dir, 'data')
    const key = loadProxySecret(inner)
    expect(loadProxySecret(inner).equals(key)).toBe(true)
  })

  it('still gives a key when the folder can not be written', () => {
    const blocked = path.join(dir, 'file')
    fs.writeFileSync(blocked, '')                 // a file where the folder should be
    expect(loadProxySecret(path.join(blocked, 'data')).length).toBe(32)
  })
})

describe('proxy: a restart keeps stream links working', () => {
  let cdn, servers
  const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\nseg1.ts?token=abc\n'
  const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\ntracks-v1a1/mono.m3u8?token=abc\n'

  const server = async (secret) => {
    const channel = { uniqueId: '1896', number: 1, name: 'Test', cmd: 'ffmpeg http://x' }
    const appState = {
      client: { getBasePath: () => 'http://portal.example.com/c/', getHttpClient: () => null, streamHeadersFor: () => ({}) },
      channelManager: {
        waitForChannel: async () => channel,
        resolveStream: async () => ({ url: `${origin(cdn)}/index.m3u8?token=abc`, type: 'hls' }),
        recordStreamSuccess: () => {},
        recordStreamError: () => {},
        invalidateResolved: () => {},
        getRawStreamUrl: () => null,
      },
    }
    const e = express()
    e.use('/proxy', proxyModule(appState, { segmentRetryMs: [10, 10], secret }))
    const s = await listen(e)
    servers.push(s)
    return s
  }
  // The media playlist link a player holds, from one server, moved to another's address.
  const mediaLink = async (from, to) => {
    const master = await (await fetch(`${origin(from)}/proxy/stream/1896`)).text()
    return master.split('\n').find((l) => l.includes('/proxy/hls?')).replace(origin(from), origin(to))
  }

  beforeAll(async () => {
    cdn = await listen((req, res) => {
      if (req.url.startsWith('/index.m3u8')) return res.end(MASTER)
      if (req.url.startsWith('/tracks-v1a1/mono.m3u8')) return res.end(MEDIA)
      res.statusCode = 404; res.end()
    })
  })
  beforeEach(() => { servers = [] })
  afterEach(() => servers.forEach((s) => s.close()))
  afterAll(() => cdn?.close())

  it('accepts links signed before the restart with the same saved key', async () => {
    const key = Buffer.alloc(32, 7)
    const before = await server(key)
    const after = await server(Buffer.from(key))
    expect((await fetch(await mediaLink(before, after))).status).toBe(200)
  })

  it('refuses them under a different key', async () => {
    const before = await server(Buffer.alloc(32, 7))
    const after = await server(Buffer.alloc(32, 8))
    expect((await fetch(await mediaLink(before, after))).status).toBe(403)
  })
})
