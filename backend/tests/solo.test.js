import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
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
const soloCast = require('../lib/soloCast.js')
const solo = require('../routes/solo.js')
const KEY = 'correct horse battery'
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

// http.request: fetch won't send a Host of our choosing, nor some methods.
function request(base, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    r.on('error', reject)
    r.end(body)
  })
}

// A request as castLink sees it.
const fakeReq = (host) => ({ protocol: 'http', get: (h) => (h.toLowerCase() === 'host' ? host : undefined) })

afterEach(() => {
  soloCast.setCastPort(0)
  soloCast.setLanHost(null)
})

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

  it('listens on HOST', () => {
    expect(load({}).host).toBe('0.0.0.0')
    expect(load({ HOST: '127.0.0.1' }).host).toBe('127.0.0.1')
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
})

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

describe('the LAN listener', () => {
  const access = createAccess({ key: KEY, logger: quiet })
  const T = access.shareToken
  let server, base

  beforeAll(async () => {
    // Like server.js: the access middleware, then stand-ins that answer 200
    // for anything — a request the LAN gate lets slip shows up as a 200.
    const app = express()
    app.use(cors())
    app.use(access.stripPrefix)
    app.use(access.gate)
    app.use((req, res) => res.json({ url: req.url }))
    server = soloCast.startLanListener({ app, port: 0, shareToken: T, logger: quiet })
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })

  it('the LAN listener answers only the cast stream under the share token', async () => {
    for (const p of [`/k/${T}/proxy/cast/live/1/index.m3u8`, `/k/${T}/proxy/stream/1`, `/k/${T}/proxy/vod/stream?cmd=x`]) {
      expect((await request(base, p)).status, p).toBe(200)
    }
    expect((await request(base, `/k/${T}/proxy/cast/live/1/index.m3u8`, { method: 'HEAD' })).status).toBe(200)
    const refused = [
      '/api/status', '/api/health', '/', '/index.html', `/k/${T}/api/x`, `/k/${T}/api/settings`,
      '/proxy/cast/live/1/index.m3u8', `/k/${KEY}/proxy/stream/1`, `/k/wrong/proxy/stream/1`,
      `/k/${T}/proxy`, `/k/${T}/stremio/manifest.json`, `/k/${T}/proxy/../api/settings`,
      `/k/${T}/proxy/%2e%2e/api/settings`, `/k/${T}/proxy%2f../api/settings`, `/K/${T}/PROXY/stream/1`,
    ]
    for (const p of refused) expect((await request(base, p)).status, p).toBe(404)
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await request(base, `/k/${T}/proxy/cast/live/1/index.m3u8`, { method })).status, method).toBe(404)
    }
  })

  it("lets a Chromecast's CORS preflight through under the share token, nowhere else", async () => {
    const preflight = { method: 'OPTIONS', headers: { Origin: 'https://receiver.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } }
    const ok = await request(base, `/k/${T}/proxy/cast/live/1/index.m3u8`, preflight)
    expect(ok.status).toBe(204)
    for (const p of ['/api/settings', `/k/${T}/api/settings`, '/proxy/stream/1', `/k/wrong/proxy/stream/1`, `/k/${T}/proxy/../api/x`]) {
      expect((await request(base, p, preflight)).status, p).toBe(404)
    }
  })

  it.skipIf(!ipv6)('answers on IPv6 too, through the same gate', async () => {
    const v6 = `http://[::1]:${server.address().port}`
    expect((await request(v6, `/k/${T}/proxy/stream/1`)).status).toBe(200)
    expect((await request(v6, '/api/health')).status).toBe(404)
    expect((await request(base, `/k/${T}/proxy/stream/1`)).status).toBe(200)
  })

  it('answers a refused request without the token or the key', async () => {
    const r = await request(base, `/k/${T}/api/settings`)
    expect(r.body).not.toContain(T)
    expect(r.body).not.toContain(KEY)
  })

  it('is not started without a share token, and says why', () => {
    const warn = vi.fn()
    const app = express()
    expect(soloCast.startLanListener({ app, port: 0, host: '127.0.0.1', shareToken: null, logger: { ...quiet, warn, error: warn } })).toBe(null)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0].join(' ')).toMatch(/ACCESS_KEY/)
  })
})

describe('cast links follow the cast listener', () => {
  const access = createAccess({ key: KEY, logger: quiet })
  const link = () => castLink(fakeReq('127.0.0.1:8983'), 'tok', '/proxy/cast/live/42/index.m3u8', 'application/x-mpegURL', true)

  it('point at the listener once it is up', async () => {
    const server = soloCast.startLanListener({ app: express(), port: 0, shareToken: access.shareToken, logger: quiet })
    try {
      soloCast.setLanHost('192.168.1.20')
      expect(link().reachable).toBe(false)   // not listening yet
      await new Promise((r) => server.once('listening', r))
      expect(soloCast.castOrigin()).toBe(`http://192.168.1.20:${server.address().port}`)
      expect(link().reachable).toBe(true)
    } finally { server.close() }
  })

  it('are unreachable when the cast port is taken', async () => {
    const holder = await busyPort()
    const port = holder.address().port
    soloCast.setCastPort(port)   // stale: what Solo said before the listener came up
    try {
      const server = soloCast.startLanListener({ app: express(), port, host: '127.0.0.1', shareToken: access.shareToken, logger: quiet })
      await new Promise((r) => server.once('error', r))
      soloCast.setLanHost('192.168.1.20')
      expect(soloCast.castOrigin()).toBe(null)
      expect(link().reachable).toBe(false)
    } finally { holder.close() }
  })

  it('are unreachable when the listener was refused (no ACCESS_KEY)', () => {
    soloCast.setCastPort(18984)
    expect(soloCast.startLanListener({ app: express(), port: 18984, shareToken: null, logger: quiet })).toBe(null)
    soloCast.setLanHost('192.168.1.20')
    expect(link().reachable).toBe(false)
  })
})

describe('Solo cast links', () => {
  it('cast links use the Wi-Fi address in Solo', () => {
    soloCast.setCastPort(18984)
    soloCast.setLanHost('192.168.1.20')
    expect(soloCast.castOrigin()).toBe('http://192.168.1.20:18984')
    const link = castLink(fakeReq('127.0.0.1:8983'), 'tok', '/proxy/cast/live/42/index.m3u8', 'application/x-mpegURL', true)
    expect(link.url).toBe('http://192.168.1.20:18984/k/tok/proxy/cast/live/42/index.m3u8')
    expect(link.reachable).toBe(true)
  })

  it('without a Wi-Fi address, a Solo cast link is marked unreachable', () => {
    soloCast.setCastPort(18984)
    expect(soloCast.castOrigin()).toBe(null)
    const link = castLink(fakeReq('127.0.0.1:8983'), 'tok', '/proxy/cast/live/42/index.m3u8', 'application/x-mpegURL', true)
    expect(link.url).toBe('http://127.0.0.1:8983/k/tok/proxy/cast/live/42/index.m3u8')
    expect(link.reachable).toBe(false)
  })

  it('outside Solo, cast links are as before', () => {
    soloCast.setLanHost('192.168.1.20')   // ignored: no cast listener
    const link = castLink(fakeReq('192.168.1.5:8983'), 'tok', '/proxy/stream/1', 'video/mp2t', true)
    expect(link).toEqual({ url: 'http://192.168.1.5:8983/k/tok/proxy/stream/1', contentType: 'video/mp2t', live: true, reachable: true })
  })

  it('takes an IPv6 Wi-Fi address in brackets', () => {
    soloCast.setCastPort(18984)
    soloCast.setLanHost('fd00::20')
    expect(soloCast.castOrigin()).toBe('http://[fd00::20]:18984')
  })
})

describe('PUT /api/solo/network', () => {
  async function serve(config) {
    const access = createAccess({ key: KEY, logger: quiet })
    const app = express()
    app.use(express.json())
    app.use(access.stripPrefix)
    app.use(access.gate)
    solo.mount(app, config, soloCast)
    app.use((_req, res) => res.status(404).end())
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    return { server, base: `http://127.0.0.1:${server.address().port}`, token: access.shareToken }
  }
  const put = (base, body, auth) => request(base, '/api/solo/network', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  })

  it('PUT /api/solo/network exists only in Solo, and needs the key', async () => {
    const docker = await serve({ solo: false })
    try {
      expect((await put(docker.base, { lanHost: '192.168.1.20' }, KEY)).status).toBe(404)
    } finally { docker.server.close() }

    soloCast.setCastPort(18984)
    const s = await serve({ solo: true })
    try {
      expect((await put(s.base, { lanHost: '192.168.1.20' })).status).toBe(401)
      expect((await put(s.base, { lanHost: '192.168.1.20' }, s.token)).status).toBe(403)
      expect(soloCast.castOrigin()).toBe(null)
      expect((await put(s.base, { lanHost: '192.168.1.20' }, KEY)).status).toBe(204)
      expect(soloCast.castOrigin()).toBe('http://192.168.1.20:18984')
      expect((await put(s.base, { lanHost: null }, KEY)).status).toBe(204)
      expect(soloCast.castOrigin()).toBe(null)
    } finally { s.server.close() }
  })

  it('refuses something that is not an address', async () => {
    soloCast.setCastPort(18984)
    const s = await serve({ solo: true })
    try {
      for (const lanHost of ['evil.example/x?', '192.168.1.20:80', 'fe80::1%wlan0', '', 42, undefined]) {
        expect((await put(s.base, { lanHost }, KEY)).status, String(lanHost)).toBe(400)
      }
      expect(soloCast.castOrigin()).toBe(null)
    } finally { s.server.close() }
  })
})
