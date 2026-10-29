import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import process from 'process'
import { createRequire } from 'module'
import express from 'express'
import cors from 'cors'
import net from 'net'
import { createAccess } from '../lib/access.js'

// Through require, as the server loads them: castLink reads the same soloCast
// state the test sets (an import would load a second copy).
const require = createRequire(import.meta.url)
const { castLink } = require('../lib/castLink.js')
const { baseUrl } = require('../lib/publicUrl.js')
const soloCast = require('../lib/soloCast.js')
const solo = require('../routes/solo.js')
const proxyModule = require('../routes/proxy.js')
const KEY = 'correct horse battery'
const quiet = { info: () => {}, warn: () => {}, error: () => {} }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// http.request: fetch won't send a Host of our choosing, nor some methods.
function request(base, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    r.on('error', reject)
    r.end(body)
  })
}

// A request as castLink sees it.
const fakeReq = (host) => ({ protocol: 'http', get: (h) => (h.toLowerCase() === 'host' ? host : undefined) })

// Whether this machine can listen on ::1 at all.
const ipv6 = await new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).listen(0, '::1', () => s.close(() => resolve(true)))
})

// A port something else already holds.
async function busyPort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  return s
}

const access = createAccess({ key: KEY, logger: quiet })
const T = access.shareToken

// Like server.js: the access middleware (with lanLinks right after it), then
// stand-ins that answer 200 for anything — a request the LAN gate lets slip
// shows up as a 200 — and say what prefix links would carry.
function appLikeServer(extra = () => {}) {
  const app = express()
  app.use(cors())
  app.use(access.stripPrefix)
  app.use(soloCast.lanLinks)
  app.use(access.gate)
  extra(app)
  app.use((req, res) => res.json({ url: req.url, links: baseUrl(req) }))
  return app
}

// Casting on, on 127.0.0.1 (the only address a test machine surely has), and
// the listener started as a cast-link request would.
async function castOn(o = {}) {
  soloCast.enable({ app: appLikeServer(o.extra), port: 0, shareToken: T, logger: quiet, ...o })
  soloCast.setLanHost(o.lanHost ?? '127.0.0.1')
  const base = await soloCast.ensureListener()
  const m = /^(http:\/\/[^/]+)(\/k\/[^/]+)$/.exec(base)
  return { base, origin: m[1], prefix: m[2] }
}

afterEach(() => soloCast.disable())

describe('Solo config', () => {
  const KEYS = ['SOLO', 'HOST', 'CAST_PORT']
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    delete require.cache[require.resolve('../config.js')]
  })
  const load = (env) => {
    for (const k of KEYS) delete process.env[k]
    Object.assign(process.env, env)
    delete require.cache[require.resolve('../config.js')]
    return require('../config.js')
  }

  it('ignores HOST outside Solo: every address, as before', () => {
    expect(load({}).host).toBe('0.0.0.0')
    expect(load({ HOST: '127.0.0.1' }).host).toBe('0.0.0.0')
    expect(load({ HOST: '192.168.1.5' }).host).toBe('0.0.0.0')
  })

  it('is Solo only with SOLO=1, and the cast port only counts there', () => {
    const docker = load({ CAST_PORT: '18984' })
    expect(docker.solo).toBe(false)
    expect(docker.castPort).toBe(0)
    const app = load({ SOLO: '1', HOST: '127.0.0.1', CAST_PORT: '18984' })
    expect(app.solo).toBe(true)
    expect(app.castPort).toBe(18984)
  })

  it('listens on 127.0.0.1 in Solo, whatever HOST says', () => {
    const log = require('../logger.js')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      expect(load({ SOLO: '1' }).host).toBe('127.0.0.1')
      expect(warn).not.toHaveBeenCalled()
      expect(load({ SOLO: '1', HOST: '127.0.0.1' }).host).toBe('127.0.0.1')
      expect(warn).not.toHaveBeenCalled()
      expect(load({ SOLO: '1', HOST: '0.0.0.0' }).host).toBe('127.0.0.1')
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0].join(' ')).toMatch(/HOST.*ignored/)
    } finally { warn.mockRestore() }
  })

  it('keeps less of a cast channel in memory in Solo', () => {
    expect(load({})).toMatchObject({ castWindow: 10, castMaxSessions: 3, castMaxPieceBytes: 32 * 1024 * 1024 })
    expect(load({ SOLO: '1' })).toMatchObject({ castWindow: 6, castMaxSessions: 1, castMaxPieceBytes: 12 * 1024 * 1024 })
  })
})

describe('the LAN listener', () => {
  it('answers only the cast stream under its cast token — not the share token', async () => {
    const { origin, prefix: C } = await castOn()
    for (const p of [`${C}/proxy/cast/live/1/index.m3u8`, `${C}/proxy/stream/1`, `${C}/proxy/vod/stream?cmd=x`]) {
      expect((await request(origin, p)).status, p).toBe(200)
    }
    expect((await request(origin, `${C}/proxy/cast/live/1/index.m3u8`, { method: 'HEAD' })).status).toBe(200)
    const refused = [
      '/api/status', '/api/health', '/', '/index.html', `${C}/api/x`, `${C}/api/settings`,
      '/proxy/cast/live/1/index.m3u8', `/k/${T}/proxy/stream/1`, `/k/${T}/proxy/cast/live/1/index.m3u8`,
      `/k/${KEY}/proxy/stream/1`, '/k/wrong/proxy/stream/1',
      `${C}/proxy`, `${C}/stremio/manifest.json`, `${C}/proxy/../api/settings`,
      `${C}/proxy/%2e%2e/api/settings`, `${C}/proxy%2f../api/settings`, `/K/${C.slice(3)}/PROXY/stream/1`,
    ]
    for (const p of refused) expect((await request(origin, p)).status, p).toBe(404)
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await request(origin, `${C}/proxy/cast/live/1/index.m3u8`, { method })).status, method).toBe(404)
    }
  })

  it('makes a cast token of its own, unguessable, not the share token', async () => {
    const { prefix } = await castOn()
    const token = prefix.slice(3)
    expect(token).not.toBe(T)
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)   // 24 random bytes
  })

  it("lets a Chromecast's CORS preflight through under the cast token, nowhere else", async () => {
    const { origin, prefix: C } = await castOn()
    const preflight = { method: 'OPTIONS', headers: { Origin: 'https://receiver.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } }
    expect((await request(origin, `${C}/proxy/cast/live/1/index.m3u8`, preflight)).status).toBe(204)
    for (const p of ['/api/settings', `${C}/api/settings`, '/proxy/stream/1', `/k/${T}/proxy/stream/1`, `${C}/proxy/../api/x`]) {
      expect((await request(origin, p, preflight)).status, p).toBe(404)
    }
  })

  it('hands out links under the cast token: the share token never leaves on the Wi-Fi', async () => {
    const castHls = { playlist: async (id) => (id === '42' ? null : '#EXTM3U\n#EXTINF:4.000,\nseg0.ts\n'), segment: () => null }
    const { origin, prefix: C } = await castOn({
      extra: (app) => {
        // The HLS rewriting builds a playlist's links on baseUrl(req) (routes/proxy.js).
        app.get('/proxy/test/playlist.m3u8', (req, res) => {
          res.type('application/vnd.apple.mpegurl').send(`#EXTM3U\n#EXTINF:4,\n${baseUrl(req)}/proxy/hls?url=x\n`)
        })
        app.use('/proxy', proxyModule({ castHls }))
      },
    })
    const answers = [
      await request(origin, `${C}/proxy/cast/live/42/index.m3u8`),   // encrypted / fMP4: sent on with a 302
      await request(origin, `${C}/proxy/test/playlist.m3u8`),
      await request(origin, `${C}/proxy/anything`),
    ]
    expect(answers[0].status).toBe(302)
    expect(answers[0].headers.location).toBe(`${origin}${C}/proxy/stream/42`)
    expect(answers[1].body).toContain(`${origin}${C}/proxy/`)
    expect(JSON.parse(answers[2].body).links).toBe(`${origin}${C}`)
    for (const a of answers) {
      expect(a.body).not.toContain(T)
      expect(a.body).not.toContain(KEY)
      expect(String(a.headers.location ?? '')).not.toContain(T)
    }
  })

  it('binds to the Wi-Fi address only', async () => {
    await castOn()
    expect(soloCast.listenerAddress().address).toBe('127.0.0.1')
  })

  it('stops when nothing was asked of it for a while, and starts again with a new token', async () => {
    const first = await castOn({ idleMs: 60 })
    expect((await request(first.origin, `${first.prefix}/proxy/stream/1`)).status).toBe(200)
    await wait(200)
    expect(soloCast.listenerAddress()).toBe(null)
    expect(soloCast.castBase()).toBe(null)
    await expect(request(first.origin, `${first.prefix}/proxy/stream/1`)).rejects.toThrow()   // nothing listening
    const again = await soloCast.ensureListener()   // the next cast link
    expect(again).not.toBe(null)
    const { origin, prefix } = /^(?<origin>http:\/\/[^/]+)(?<prefix>\/k\/[^/]+)$/.exec(again).groups
    expect(prefix).not.toBe(first.prefix)
    expect((await request(origin, `${first.prefix}/proxy/stream/1`)).status).toBe(404)   // the old token is no good
    expect((await request(origin, `${prefix}/proxy/stream/1`)).status).toBe(200)
  })

  it('stays up while a channel is cast, or a request is still being answered', async () => {
    let cast = 1
    let release
    const { origin, prefix } = await castOn({
      idleMs: 60,
      castSessions: () => cast,
      extra: (app) => app.get('/proxy/long', (_req, res) => { res.write('x'); release = () => res.end() }),
    })
    await wait(200)
    expect(soloCast.listenerAddress()).not.toBe(null)   // a channel is being cast
    cast = 0
    const long = new Promise((resolve) => http.get(`${origin}${prefix}/proxy/long`, (r) => { r.resume(); r.on('end', resolve) }))
    await wait(200)
    expect(soloCast.listenerAddress()).not.toBe(null)   // a movie being read, one long request
    release()
    await long
    await wait(200)
    expect(soloCast.listenerAddress()).toBe(null)
  })

  it('is not started without a share token, and says why', async () => {
    const warn = vi.fn()
    expect(soloCast.enable({ app: express(), port: 0, shareToken: null, logger: { ...quiet, warn, error: warn } })).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0].join(' ')).toMatch(/ACCESS_KEY/)
    soloCast.setLanHost('127.0.0.1')
    expect(await soloCast.ensureListener()).toBe(null)
  })

  it.skipIf(!ipv6)('moves to a new Wi-Fi address with a new token, and stops without one', async () => {
    const first = await castOn()
    soloCast.setLanHost('::1')
    const moved = await soloCast.ensureListener()
    expect(moved).toMatch(/^http:\/\/\[::1\]:\d+\/k\//)
    expect(moved.endsWith(first.prefix)).toBe(false)
    expect(soloCast.listenerAddress().address).toBe('::1')
    soloCast.setLanHost(null)
    expect(soloCast.listenerAddress()).toBe(null)
    expect(await soloCast.ensureListener()).toBe(null)
  })
})

describe('cast links follow the cast listener', () => {
  const link = () => castLink(fakeReq('127.0.0.1:8983'), T, '/proxy/cast/live/42/index.m3u8', 'application/x-mpegURL', true)

  it('start it, and point at it on the Wi-Fi address, under its cast token', async () => {
    soloCast.enable({ app: appLikeServer(), port: 0, shareToken: T, logger: quiet })
    soloCast.setLanHost('127.0.0.1')
    expect(soloCast.listenerAddress()).toBe(null)   // only once a link is asked for
    const l = await link()
    const port = soloCast.listenerAddress().port
    expect(l.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/k/[A-Za-z0-9_-]{32}/proxy/cast/live/42/index\\.m3u8$`))
    expect(l.url).not.toContain(T)
    expect(l).toMatchObject({ contentType: 'application/x-mpegURL', live: true, reachable: true })
    expect((await link()).url).toBe(l.url)   // the same listener while it's up
  })

  it('are unreachable without a Wi-Fi address', async () => {
    soloCast.enable({ app: appLikeServer(), port: 0, shareToken: T, logger: quiet })
    const l = await link()
    expect(l.reachable).toBe(false)
    expect(l.url.startsWith('http://127.0.0.1:8983/')).toBe(true)
    expect(soloCast.listenerAddress()).toBe(null)
  })

  it('are unreachable when the cast port is taken', async () => {
    const holder = await busyPort()
    try {
      soloCast.enable({ app: appLikeServer(), port: holder.address().port, shareToken: T, logger: quiet })
      soloCast.setLanHost('127.0.0.1')
      expect((await link()).reachable).toBe(false)
      expect(soloCast.castBase()).toBe(null)
    } finally { holder.close() }
  })

  it('outside Solo, are as before', async () => {
    soloCast.setLanHost('192.168.1.20')   // ignored: casting isn't on
    const l = await castLink(fakeReq('192.168.1.5:8983'), 'tok', '/proxy/stream/1', 'video/mp2t', true)
    expect(l).toEqual({ url: 'http://192.168.1.5:8983/k/tok/proxy/stream/1', contentType: 'video/mp2t', live: true, reachable: true })
    expect(soloCast.listenerAddress()).toBe(null)
  })
})

describe('PUT /api/solo/network', () => {
  async function serve(config) {
    const app = express()
    app.use(express.json())
    app.use(access.stripPrefix)
    app.use(access.gate)
    solo.mount(app, config, soloCast)
    app.use((_req, res) => res.status(404).end())
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    return { server, base: `http://127.0.0.1:${server.address().port}` }
  }
  const put = (base, body, auth) => request(base, '/api/solo/network', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  })

  it('exists only in Solo, and needs the key', async () => {
    const docker = await serve({ solo: false })
    try {
      expect((await put(docker.base, { lanHost: '192.168.1.20' }, KEY)).status).toBe(404)
    } finally { docker.server.close() }

    const s = await serve({ solo: true })
    try {
      expect((await put(s.base, { lanHost: '192.168.1.20' })).status).toBe(401)
      expect((await put(s.base, { lanHost: '192.168.1.20' }, T)).status).toBe(403)
      expect(soloCast.getLanHost()).toBe(null)
      expect((await put(s.base, { lanHost: '192.168.1.20' }, KEY)).status).toBe(204)
      expect(soloCast.getLanHost()).toBe('192.168.1.20')
      expect((await put(s.base, { lanHost: null }, KEY)).status).toBe(204)
      expect(soloCast.getLanHost()).toBe(null)
    } finally { s.server.close() }
  })

  it('moves a running cast listener to the new address', async () => {
    const first = await castOn()
    const s = await serve({ solo: true })
    try {
      expect((await put(s.base, { lanHost: null }, KEY)).status).toBe(204)
      expect(soloCast.listenerAddress()).toBe(null)
      await expect(request(first.origin, `${first.prefix}/proxy/stream/1`)).rejects.toThrow()
    } finally { s.server.close() }
  })

  it('refuses something that is not an address', async () => {
    const s = await serve({ solo: true })
    try {
      for (const lanHost of ['evil.example/x?', '192.168.1.20:80', 'fe80::1%wlan0', '', 42, undefined]) {
        expect((await put(s.base, { lanHost }, KEY)).status, String(lanHost)).toBe(400)
      }
      expect(soloCast.getLanHost()).toBe(null)
    } finally { s.server.close() }
  })
})
