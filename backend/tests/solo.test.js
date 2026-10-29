import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import process from 'process'
import { createRequire } from 'module'
import express from 'express'
import cors from 'cors'
import net from 'net'
import { setInterval, clearInterval } from 'timers'
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

const CH1 = '/proxy/cast/live/1/index.m3u8'
const splitBase = (base) => {
  const m = /^(http:\/\/[^/]+)(\/k\/[^/]+)$/.exec(base)
  return { base, origin: m[1], prefix: m[2] }
}

// Casting on, on 127.0.0.1 (the only address a test machine surely has), and
// a cast link asked for (channel 1's, unless `path` says), as the app would.
async function castOn(o = {}) {
  soloCast.enable({ app: appLikeServer(o.extra), shareToken: T, logger: quiet, ...o })
  soloCast.setLanHost(o.lanHost ?? '127.0.0.1')
  return splitBase(await soloCast.ensureListener(o.path ?? CH1))
}
// Another cast link on the listener that's up.
const linkFor = async (path) => splitBase(await soloCast.ensureListener(path))

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

  it('is Solo only with SOLO=1, and reads no cast port (the listener picks a free one)', () => {
    const docker = load({ CAST_PORT: '18984' })
    expect(docker.solo).toBe(false)
    expect(docker.castPort).toBeUndefined()
    const app = load({ SOLO: '1', HOST: '127.0.0.1', CAST_PORT: '18984' })
    expect(app.solo).toBe(true)
    expect(app.castPort).toBeUndefined()
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
  it('answers only the cast stream its cast token was made for — not the share token', async () => {
    const { origin, prefix: C } = await castOn()
    expect((await request(origin, `${C}/proxy/cast/live/1/index.m3u8`)).status).toBe(200)
    expect((await request(origin, `${C}/proxy/cast/live/1/index.m3u8`, { method: 'HEAD' })).status).toBe(200)
    const refused = [
      `${C}/proxy/stream/1`, `${C}/proxy/stream/2`, `${C}/proxy/vod/stream?cmd=x`, `${C}/proxy/cast/live/2/index.m3u8`,
      `${C}/proxy/cast/live/1/seg0.ts`, `${C}/proxy/cast/live/1/index.m3u8?x=1`,
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
    for (const p of ['/api/settings', `${C}/api/settings`, '/proxy/stream/1', `/k/${T}/proxy/stream/1`, `${C}/proxy/../api/x`, `${C}/proxy/stream/2`]) {
      expect((await request(origin, p, preflight)).status, p).toBe(404)
    }
  })

  it('hands out links under the cast token: the share token never leaves on the Wi-Fi', async () => {
    const castHls = { playlist: async (id) => (id === '42' ? null : '#EXTM3U\n#EXTINF:4.000,\nseg0.ts\n'), segment: () => null }
    const { origin, prefix: C } = await castOn({
      path: '/proxy/cast/live/42/index.m3u8',
      extra: (app) => {
        // The HLS rewriting builds a playlist's links on baseUrl(req) (routes/proxy.js).
        app.get('/proxy/test/playlist.m3u8', (req, res) => {
          res.type('application/vnd.apple.mpegurl').send(`#EXTM3U\n#EXTINF:4,\n${baseUrl(req)}/proxy/hls?url=x\n`)
        })
        app.use('/proxy', proxyModule({ castHls }))
      },
    })
    const P = (await linkFor('/proxy/test/playlist.m3u8')).prefix
    const A = (await linkFor('/proxy/anything')).prefix
    const answers = [
      await request(origin, `${C}/proxy/cast/live/42/index.m3u8`),   // encrypted / fMP4: sent on with a 302
      await request(origin, `${P}/proxy/test/playlist.m3u8`),
      await request(origin, `${A}/proxy/anything`),
    ]
    expect(answers[0].status).toBe(302)
    expect(answers[0].headers.location).toBe(`${origin}${C}/proxy/stream/42`)
    expect(answers[1].body).toContain(`${origin}${P}/proxy/`)
    expect(JSON.parse(answers[2].body).links).toBe(`${origin}${A}`)
    expect(new Set([C, P, A]).size).toBe(3)   // a token for each link
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
    expect((await request(first.origin, `${first.prefix}${CH1}`)).status).toBe(200)
    await wait(200)
    expect(soloCast.listenerAddress()).toBe(null)
    expect(soloCast.castOrigin()).toBe(null)
    await expect(request(first.origin, `${first.prefix}${CH1}`)).rejects.toThrow()   // nothing listening
    const again = await soloCast.ensureListener(CH1)   // the next cast link
    expect(again).not.toBe(null)
    const { origin, prefix } = splitBase(again)
    expect(prefix).not.toBe(first.prefix)
    expect((await request(origin, `${first.prefix}${CH1}`)).status).toBe(404)   // the old token is no good
    expect((await request(origin, `${prefix}${CH1}`)).status).toBe(200)
  })

  it("stops on time though strangers keep knocking: a refused request isn't the TV asking", async () => {
    const { origin } = await castOn({ idleMs: 100 })
    const knock = setInterval(() => { request(origin, '/api/settings').catch(() => {}) }, 20)
    try {
      await wait(400)
      expect(soloCast.listenerAddress()).toBe(null)
    } finally { clearInterval(knock) }
  })

  it.skipIf(!ipv6)('gives a cast link asked for while the Wi-Fi address changes the new listener, not none', async () => {
    soloCast.enable({ app: appLikeServer(), shareToken: T, logger: quiet })
    soloCast.setLanHost('127.0.0.1')
    const asked = soloCast.ensureListener(CH1)   // the listener is starting…
    soloCast.setLanHost('::1')                   // …and moves before it's up
    const l = await asked
    expect(l).toMatch(/^http:\/\/\[::1\]:\d+\/k\//)
    const { origin, prefix } = splitBase(l)
    expect((await request(origin, `${prefix}${CH1}`)).status).toBe(200)
  })

  it('stays up while a channel is cast, or a request is still being answered', async () => {
    let cast = 1
    let release
    const { origin, prefix } = await castOn({
      idleMs: 60,
      path: '/proxy/long',
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
    expect(soloCast.enable({ app: express(), shareToken: null, logger: { ...quiet, warn, error: warn } })).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0].join(' ')).toMatch(/ACCESS_KEY/)
    soloCast.setLanHost('127.0.0.1')
    expect(await soloCast.ensureListener(CH1)).toBe(null)
  })

  it.skipIf(!ipv6)('moves to a new Wi-Fi address with a new token, and stops without one', async () => {
    const first = await castOn()
    soloCast.setLanHost('::1')
    const moved = await soloCast.ensureListener(CH1)
    expect(moved).toMatch(/^http:\/\/\[::1\]:\d+\/k\//)
    expect(moved.endsWith(first.prefix)).toBe(false)
    expect(soloCast.listenerAddress().address).toBe('::1')
    soloCast.setLanHost(null)
    expect(soloCast.listenerAddress()).toBe(null)
    expect(await soloCast.ensureListener(CH1)).toBe(null)
  })
})

describe('what a cast token opens', () => {
  // As routes/proxy.js answers: the cast channel's playlist and pieces
  // (relative seg<n>.ts), a channel passed through with a 302, and that
  // channel's own HLS rewritten onto baseUrl(req) — stand-ins for the last.
  const castHls = {
    playlist: async (id) => (id === '42' ? null : `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\nseg0.ts\n#EXTINF:4.000,\nseg1.ts\n`),
    segment: (id, name) => (/^seg[01]\.ts$/.test(name) ? Buffer.from(`ch${id} ${name}`) : null),
  }
  const extra = (app) => {
    app.get('/proxy/stream/:id', (req, res) => {
      const b = baseUrl(req)
      res.type('application/vnd.apple.mpegurl').send(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${b}/proxy/hls?url=key${req.params.id}&sig=s"\n`
        + `#EXTINF:4,\n${b}/proxy/hls/seg/c${req.params.id}a.ts?sig=s&ch=${req.params.id}\n#EXTINF:4,\n${b}/proxy/hls?url=sub${req.params.id}&sig=s\n`)
    })
    app.get('/proxy/hls/seg/:name', (req, res) => res.type('video/mp2t').send(`piece ${req.params.name}`))
    app.get('/proxy/hls', (req, res) => res.type('text/plain').send(`hls ${req.query.url}`))
    app.get(/^\/proxy\/vod\/stream/, (req, res) => res.type('video/x-matroska').send(`movie ${req.query.videoId}`))
    app.use('/proxy', proxyModule({ castHls }))
  }
  const linesOf = (body) => body.split('\n').filter((l) => l && !l.startsWith('#'))

  it("opens a channel's playlist and its pieces — not another channel, nor a movie", async () => {
    const { origin, prefix: C } = await castOn({ extra })
    const pl = await request(origin, `${C}/proxy/cast/live/1/index.m3u8`)
    expect(pl.status).toBe(200)
    expect(linesOf(pl.body)).toEqual(['seg0.ts', 'seg1.ts'])
    for (const name of linesOf(pl.body)) {
      const seg = await request(origin, `${C}/proxy/cast/live/1/${name}`)
      expect(seg.status, name).toBe(200)
      expect(seg.body).toBe(`ch1 ${name}`)
    }
    for (const p of ['/proxy/cast/live/1/seg2.ts', '/proxy/stream/1', '/proxy/stream/2', '/proxy/cast/live/2/index.m3u8',
      '/proxy/cast/live/2/seg0.ts', '/proxy/vod/stream?videoId=7&cmd=x', '/proxy/vod/stream.mkv?videoId=7&cmd=x', '/proxy/hls/seg/c2a.ts?sig=s&ch=2']) {
      expect((await request(origin, `${C}${p}`)).status, p).toBe(404)
    }
  })

  it('opens where a passthrough sends the TV, and the links in what it finds there', async () => {
    const { origin, prefix: C } = await castOn({ extra, path: '/proxy/cast/live/42/index.m3u8' })
    expect((await request(origin, `${C}/proxy/stream/42`)).status).toBe(404)   // not before it was handed out
    const r = await request(origin, `${C}/proxy/cast/live/42/index.m3u8`)
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(`${origin}${C}/proxy/stream/42`)
    const hls = await request(origin, `${C}/proxy/stream/42`)
    expect(hls.status).toBe(200)
    const [seg, sub] = linesOf(hls.body)
    expect(seg).toBe(`${origin}${C}/proxy/hls/seg/c42a.ts?sig=s&ch=42`)
    expect((await request(origin, seg.slice(origin.length))).status).toBe(200)
    expect((await request(origin, sub.slice(origin.length))).status).toBe(200)                         // a variant playlist
    expect((await request(origin, `${C}/proxy/hls?url=key42&sig=s`)).status).toBe(200)                 // URI="…" in a tag
    expect((await request(origin, `${C}/proxy/hls/seg/c43a.ts?sig=s&ch=43`)).status).toBe(404)
    expect((await request(origin, `${C}/proxy/stream/43`)).status).toBe(404)
  })

  it("keeps each link's token to its own stream", async () => {
    const { origin, prefix: C1 } = await castOn({ extra })
    const { prefix: V } = await linkFor('/proxy/vod/stream.mkv?videoId=7&cmd=x')
    const { prefix: C42 } = await linkFor('/proxy/cast/live/42/index.m3u8')
    expect((await request(origin, `${V}/proxy/vod/stream.mkv?videoId=7&cmd=x`)).status).toBe(200)
    expect((await request(origin, `${V}/proxy/vod/stream.mkv?videoId=8&cmd=x`)).status).toBe(404)
    expect((await request(origin, `${V}/proxy/cast/live/1/index.m3u8`)).status).toBe(404)   // a movie's token opens no channel
    expect((await request(origin, `${V}/proxy/stream/1`)).status).toBe(404)
    await request(origin, `${C42}/proxy/cast/live/42/index.m3u8`)   // hands out /proxy/stream/42 under C42…
    expect((await request(origin, `${C1}/proxy/stream/42`)).status).toBe(404)   // …not under channel 1's
    expect((await request(origin, `${C42}/proxy/stream/42`)).status).toBe(200)
    await request(origin, `${C1}/proxy/cast/live/1/index.m3u8`)
    expect((await request(origin, `${C42}/proxy/cast/live/1/seg0.ts`)).status).toBe(404)
  })

  it('refuses a path with a double slash in it', async () => {
    const { origin, prefix: C } = await castOn({ extra })
    for (const p of ['/proxy//cast/live/1/index.m3u8', '/proxy/cast//live/1/index.m3u8', '//proxy/cast/live/1/index.m3u8']) {
      expect((await request(origin, `${C}${p}`)).status, p).toBe(404)
    }
    expect((await request(origin, `${C}${CH1}`)).status).toBe(200)
  })

  it('opens the poster its cast link was made with, and no other image', async () => {
    const poster = '/api/logos/render?url=http%3A%2F%2Fportal.example%2Fp%2F1.jpg'
    const { origin, prefix: C } = await castOn({ extra: (app) => app.get('/api/logos/render', (req, res) => res.type('image/png').send(`png ${req.query.url}`)) })
    expect((await request(origin, `${C}${poster}`)).status).toBe(404)   // channel 1's token: no poster
    const l = await castLink(fakeReq('127.0.0.1:8983'), T, '/proxy/vod/stream.mkv?videoId=7&cmd=x', 'video/x-matroska', false, poster)
    const { origin: o2, prefix: V } = splitBase(l.url.slice(0, l.url.indexOf('/proxy/')))
    expect(l.imageUrl).toBe(`${o2}${V}${poster}`)
    const img = await request(o2, `${V}${poster}`)
    expect(img.status).toBe(200)
    expect(img.body).toBe('png http://portal.example/p/1.jpg')
    expect((await request(o2, `${V}/api/logos/render?url=http%3A%2F%2Fportal.example%2Fp%2F2.jpg`)).status).toBe(404)
    expect((await request(o2, `${V}/api/logos/map`)).status).toBe(404)
    // Only a poster this server renders is taken; anything else is left out.
    for (const bad of ['/api/settings', '/proxy/stream/1', 'http://portal.example/p.jpg', '/api/logos/../settings?x', '/api/logos/render/../../settings?x', 42]) {
      const x = await castLink(fakeReq('127.0.0.1:8983'), T, CH1, 'application/x-mpegURL', true, bad)
      expect(x.imageUrl, String(bad)).toBeUndefined()
    }
  })

  it('takes a free port each time it starts, whatever port it was given, and links use it', async () => {
    const holder = await busyPort()
    try {
      const first = await castOn({ port: holder.address().port })   // a port that's taken: not used
      const p1 = soloCast.listenerAddress().port
      expect(p1).not.toBe(holder.address().port)
      expect(first.origin).toBe(`http://127.0.0.1:${p1}`)
      soloCast.setLanHost(null)   // stops
      const again = net.createServer()   // its old port, taken now
      await new Promise((r) => again.listen(p1, '127.0.0.1', r))
      try {
        soloCast.setLanHost('127.0.0.1')
        const l = await castLink(fakeReq('127.0.0.1:8983'), T, CH1, 'application/x-mpegURL', true)
        const p2 = soloCast.listenerAddress().port
        expect(p2).not.toBe(p1)
        expect(l.reachable).toBe(true)
        expect(l.url.startsWith(`http://127.0.0.1:${p2}/k/`)).toBe(true)
      } finally { again.close() }
    } finally { holder.close() }
  })
})

describe('a cast the app says is on', () => {
  it("keeps the listener up past the idle time, the link still good — a paused movie", async () => {
    const { origin, prefix } = await castOn({ idleMs: 60 })
    soloCast.setCasting(true)
    expect(soloCast.castingActive()).toBe(true)
    await wait(250)
    expect(soloCast.listenerAddress()).not.toBe(null)
    expect((await request(origin, `${prefix}${CH1}`)).status).toBe(200)   // same port, same token
  })

  it('lets the idle rule back once the cast is over', async () => {
    await castOn({ idleMs: 60 })
    soloCast.setCasting(true)
    await wait(150)
    soloCast.setCasting(false)
    expect(soloCast.castingActive()).toBe(false)
    await wait(250)
    expect(soloCast.listenerAddress()).toBe(null)
  })

  it('holds only so long without a request (the 6-hour limit)', async () => {
    await castOn({ idleMs: 40, castingMaxMs: 200 })
    soloCast.setCasting(true)
    await wait(120)
    expect(soloCast.listenerAddress()).not.toBe(null)
    await wait(300)
    expect(soloCast.listenerAddress()).toBe(null)
    expect(soloCast.castingActive()).toBe(false)
  })
})

describe('cast links follow the cast listener', () => {
  const link = () => castLink(fakeReq('127.0.0.1:8983'), T, '/proxy/cast/live/42/index.m3u8', 'application/x-mpegURL', true)

  it('start it, and point at it on the Wi-Fi address, each under a cast token of its own', async () => {
    soloCast.enable({ app: appLikeServer(), shareToken: T, logger: quiet })
    soloCast.setLanHost('127.0.0.1')
    expect(soloCast.listenerAddress()).toBe(null)   // only once a link is asked for
    const l = await link()
    const port = soloCast.listenerAddress().port
    expect(l.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/k/[A-Za-z0-9_-]{32}/proxy/cast/live/42/index\\.m3u8$`))
    expect(l.url).not.toContain(T)
    expect(l).toMatchObject({ contentType: 'application/x-mpegURL', live: true, reachable: true })
    const next = await link()
    expect(next.url.split('/k/')[0]).toBe(l.url.split('/k/')[0])   // the same listener while it's up…
    expect(next.url).not.toBe(l.url)                                // …with a new token
  })

  it('are unreachable without a Wi-Fi address', async () => {
    soloCast.enable({ app: appLikeServer(), shareToken: T, logger: quiet })
    const l = await link()
    expect(l.reachable).toBe(false)
    expect(l.url.startsWith('http://127.0.0.1:8983/')).toBe(true)
    expect(soloCast.listenerAddress()).toBe(null)
  })

  it("are unreachable when the listener can't start there", async () => {
    soloCast.enable({ app: appLikeServer(), shareToken: T, logger: quiet })
    soloCast.setLanHost('192.0.2.1')   // not this machine's (TEST-NET-1): can't listen on it
    expect((await link()).reachable).toBe(false)
    expect(soloCast.castOrigin()).toBe(null)
  })

  it('outside Solo, are as before', async () => {
    soloCast.setLanHost('192.168.1.20')   // ignored: casting isn't on
    const l = await castLink(fakeReq('192.168.1.5:8983'), 'tok', '/proxy/stream/1', 'video/mp2t', true)
    expect(l).toEqual({ url: 'http://192.168.1.5:8983/k/tok/proxy/stream/1', contentType: 'video/mp2t', live: true, reachable: true })
    expect(soloCast.listenerAddress()).toBe(null)
    // A poster comes back under the share token, which opens /api/logos.
    const p = await castLink(fakeReq('192.168.1.5:8983'), 'tok', '/proxy/stream/1', 'video/mp2t', true, '/api/logos/render?url=x')
    expect(p.imageUrl).toBe('http://192.168.1.5:8983/k/tok/api/logos/render?url=x')
  })

  it('give a proof for /api/health only with a key and a real nonce', () => {
    const nonce = 'abcdefghijklmnop0123'
    const want = require('crypto').createHmac('sha256', KEY).update(`solo-health:${nonce}`).digest('hex')
    expect(solo.healthProof(KEY, nonce)).toBe(want)
    expect(solo.healthProof(KEY, 'short')).toBe(null)
    expect(solo.healthProof(KEY, 'x'.repeat(129))).toBe(null)
    expect(solo.healthProof(KEY, 'abcdefghijklmnop/../')).toBe(null)
    expect(solo.healthProof('', nonce)).toBe(null)
    expect(solo.healthProof(KEY, ['abcdefghijklmnop0123'])).toBe(null)
  })
})

describe('PUT /api/solo/network', () => {
  async function serve(config, deps) {
    const app = express()
    app.use(express.json())
    app.use(access.stripPrefix)
    app.use(access.gate)
    solo.mount(app, config, soloCast, deps)
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

describe('PUT /api/solo/casting and GET /api/solo/status', () => {
  async function serve(config, deps) {
    const app = express()
    app.use(express.json())
    app.use(access.stripPrefix)
    app.use(access.gate)
    solo.mount(app, config, soloCast, deps)
    app.use((_req, res) => res.status(404).end())
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    return { server, base: `http://127.0.0.1:${server.address().port}` }
  }
  const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {})
  const casting = (base, body, key) => request(base, '/api/solo/casting', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth(key) }, body: JSON.stringify(body),
  })
  const status = async (base, key) => {
    const r = await request(base, '/api/solo/status', { headers: auth(key) })
    return { status: r.status, body: r.status === 200 ? JSON.parse(r.body) : null }
  }

  it('exist only in Solo, and need the key', async () => {
    const docker = await serve({ solo: false })
    try {
      expect((await casting(docker.base, { active: true }, KEY)).status).toBe(404)
      expect((await status(docker.base, KEY)).status).toBe(404)
    } finally { docker.server.close() }
    soloCast.enable({ app: express(), shareToken: T, logger: quiet })
    const s = await serve({ solo: true })
    try {
      expect((await casting(s.base, { active: true })).status).toBe(401)
      expect((await casting(s.base, { active: true }, T)).status).toBe(403)
      expect((await status(s.base)).status).toBe(401)
      expect((await status(s.base, T)).status).toBe(403)
      expect(soloCast.castingActive()).toBe(false)
    } finally { s.server.close() }
  })

  it('takes the cast as on or over, and refuses anything but true or false', async () => {
    soloCast.enable({ app: express(), shareToken: T, logger: quiet })
    const s = await serve({ solo: true })
    try {
      for (const active of ['yes', 1, null, undefined]) {
        expect((await casting(s.base, { active }, KEY)).status, String(active)).toBe(400)
      }
      expect((await casting(s.base, { active: true }, KEY)).status).toBe(204)
      expect(soloCast.castingActive()).toBe(true)
      expect((await casting(s.base, { active: false }, KEY)).status).toBe(204)
      expect(soloCast.castingActive()).toBe(false)
    } finally { s.server.close() }
  })

  it('says whether a download or a cast still needs the server', async () => {
    soloCast.enable({ app: express(), shareToken: T, logger: quiet })
    let downloads = false
    let sessions = 0
    const s = await serve({ solo: true }, { downloadsActive: () => downloads, castSessions: () => sessions })
    try {
      expect(await status(s.base, KEY)).toEqual({ status: 200, body: { downloadsActive: false, castActive: false } })
      downloads = true
      expect((await status(s.base, KEY)).body).toEqual({ downloadsActive: true, castActive: false })
      downloads = false
      sessions = 1   // a channel being cast
      expect((await status(s.base, KEY)).body).toEqual({ downloadsActive: false, castActive: true })
      sessions = 0
      await casting(s.base, { active: true }, KEY)   // the app said a cast is on (a movie)
      expect((await status(s.base, KEY)).body).toEqual({ downloadsActive: false, castActive: true })
      await casting(s.base, { active: false }, KEY)
      expect((await status(s.base, KEY)).body).toEqual({ downloadsActive: false, castActive: false })
    } finally { s.server.close() }
  })
})
