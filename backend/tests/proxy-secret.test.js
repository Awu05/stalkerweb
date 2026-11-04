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
const closed = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve) })

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

  it('leaves a key file it can not read right now alone', () => {
    const file = path.join(dir, 'proxy-secret')
    fs.mkdirSync(file)                            // reading fails (EISDIR), but not because it's missing
    expect(loadProxySecret(dir).length).toBe(32)
    expect(fs.statSync(file).isDirectory()).toBe(true)
  })

  it('writes the key whole, for its owner only', () => {
    fs.writeFileSync(path.join(dir, 'proxy-secret.tmp'), 'left from a crash')
    loadProxySecret(dir)
    expect(fs.existsSync(path.join(dir, 'proxy-secret.tmp'))).toBe(false)
    if (os.platform() !== 'win32') expect(fs.statSync(path.join(dir, 'proxy-secret')).mode & 0o077).toBe(0)
  })

  it('still gives a key when the folder can not be written', () => {
    const blocked = path.join(dir, 'file')
    fs.writeFileSync(blocked, '')                 // a file where the folder should be
    expect(loadProxySecret(path.join(blocked, 'data')).length).toBe(32)
  })
})

describe('proxy: a restart keeps stream links working', () => {
  let cdn, servers
  const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n' +
    [1, 2, 3, 4].map((n) => `#EXTINF:4,\nseg${n}.ts?token=abc`).join('\n') + '\n'
  const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\ntracks-v1a1/mono.m3u8?token=abc\n'

  const server = async (secret, { buffer = 0 } = {}) => {
    const channel = { uniqueId: '1896', number: 1, name: 'Test', cmd: 'ffmpeg http://x' }
    const appState = {
      getLiveBufferSeconds: () => buffer,
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
  const seq = (pl) => Number(/#EXT-X-MEDIA-SEQUENCE:([0-9]+)/.exec(pl)[1])

  beforeAll(async () => {
    cdn = await listen((req, res) => {
      if (req.url.startsWith('/index.m3u8')) return res.end(MASTER)
      if (req.url.startsWith('/tracks-v1a1/mono.m3u8')) return res.end(MEDIA)
      if (req.url.startsWith('/tracks-v1a1/seg')) return res.end(Buffer.alloc(188 * 4, 0x47))
      res.statusCode = 404; res.end()
    })
  })
  beforeEach(() => { servers = [] })
  afterEach(() => Promise.all(servers.map(closed)))
  afterAll(() => cdn && closed(cdn))

  it('accepts links signed before the restart with the same saved key', async () => {
    const key = Buffer.alloc(32, 7)
    const before = await server(key)
    const after = await server(Buffer.from(key))
    expect((await fetch(await mediaLink(before, after))).status).toBe(200)
  })

  it('with the live buffer on, numbers the new playlist above the old one', async () => {
    const key = Buffer.alloc(32, 7)
    const before = await server(key, { buffer: 8 })
    const link = await mediaLink(before, before)
    const old = await (await fetch(link)).text()
    const lastOld = seq(old) + old.split('\n').filter((l) => l.includes('/proxy/hls/seg/')).length - 1
    await new Promise((r) => setTimeout(r, 400))  // the restart
    const after = await server(Buffer.from(key), { buffer: 8 })
    const res = await fetch(link.replace(origin(before), origin(after)))
    expect(res.status).toBe(200)
    expect(seq(await res.text())).toBeGreaterThan(lastOld)
  })

  it('takes no key shorter than 32 bytes', async () => {
    const before = await server(Buffer.alloc(0))
    const after = await server(Buffer.alloc(0))
    expect((await fetch(await mediaLink(before, after))).status).toBe(403)
  })

  it('refuses them under a different key', async () => {
    const before = await server(Buffer.alloc(32, 7))
    const after = await server(Buffer.alloc(32, 8))
    expect((await fetch(await mediaLink(before, after))).status).toBe(403)
  })
})
