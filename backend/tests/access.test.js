import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { createAccess, levelFor } from '../lib/access.js'
import { baseUrl } from '../lib/publicUrl.js'

const KEY = 'correct horse battery'
const quiet = { info: () => {}, warn: () => {} }

// A small app with the access middleware in front of stand-ins for each kind
// of route (mounted like server.js mounts them); each answers with the link
// base it would hand out. A catch-all at the end answers 200 like the web
// app's page fallback, so a request that slips past the gate shows up.
function appWith(access) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use(access.stripPrefix)
  app.use('/api/access', access.routes())
  app.use(access.gate)
  const echo = (req, res) => res.json({ base: baseUrl(req), url: req.originalUrl })
  const api = express.Router()
  api.get('/health', echo)
  api.get('/settings', echo)
  api.post('/auth/connect', echo)
  api.get('/m3u', echo)
  api.get('/logs', echo)
  api.get('/logos/render', echo)
  app.use('/api', api)
  const proxy = express.Router()
  proxy.get('/stream/:id', echo)
  app.use('/proxy', proxy)
  const stremio = express.Router()
  stremio.use(echo)
  app.use('/stremio', stremio)
  app.all('/player_api.php', echo)
  app.get('/get.php', echo)
  app.get('/live/:user/:pass/:file', echo)
  app.get(/.*/, (_req, res) => res.type('html').send('<html>app</html>'))
  return app
}

async function listen(access) {
  const server = appWith(access).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

describe('access key', () => {
  let server, origin, access
  const get = (path, opts = {}) => fetch(origin + path, opts)

  beforeAll(async () => {
    access = createAccess({ key: KEY, logger: quiet })
    ;({ server, origin } = await listen(access))
  })
  afterAll(() => server.close())

  it('leaves the health check and the web app itself open', async () => {
    for (const p of ['/api/health', '/', '/channels', '/assets/index-abc.js', '/favicon.svg']) {
      expect((await get(p)).status, p).toBe(200)
    }
    expect(await (await get('/api/access/status')).json()).toEqual({ enabled: true, authenticated: false })
  })

  it('refuses the API, streams and playlists without the key', async () => {
    for (const p of ['/api/settings', '/api/m3u', '/proxy/stream/7', '/stremio/manifest.json', '/player_api.php']) {
      expect((await get(p)).status, p).toBe(401)
    }
    expect(await (await get('/api/settings')).json()).toMatchObject({ accessRequired: true })
  })

  it('refuses every spelling routing accepts — case, trailing slash, repeated slash, encoding', async () => {
    for (const p of [
      '/API/settings', '/Api/Settings/', '/api//settings', '/%61pi/settings', '/api/settings/',
      '/PROXY/stream/7', '/proxy/stream/7/', '/Stremio/manifest.json', '/stremio',
      '/Player_api.php', '/player_api.php/?action=get_live_streams', '/get.php/',
      '/live/a/x/7.ts/', '/Live/a/x/7.ts', '/LIVE/a/x/7',
      '/unknown.php', '/api/logs',
    ]) {
      expect((await get(p)).status, p).toBe(401)
    }
    expect((await get('/API/auth/connect', { method: 'POST' })).status).toBe(401)
    expect((await get('/channels', { method: 'POST' })).status).toBe(401)   // only reading a page is open
  })

  it('signs the web UI in with the key and remembers it in a cookie', async () => {
    expect((await get('/api/access/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) })).status).toBe(401)
    const ok = await get('/api/access/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY }) })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie')
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).not.toContain(KEY)
    const session = cookie.split(';')[0]
    expect((await get('/api/settings', { headers: { cookie: session } })).status).toBe(200)
    expect(await (await get('/api/access/status', { headers: { cookie: session } })).json()).toEqual({ enabled: true, authenticated: true })
    // Links handed to the browser itself need no token — it sends the cookie.
    expect((await (await get('/api/m3u', { headers: { cookie: session } })).json()).base).toBe(origin)
  })

  it('accepts the key as a bearer token, and hands out links with the share token', async () => {
    const r = await get('/api/settings', { headers: { authorization: `Bearer ${KEY}` } })
    expect(r.status).toBe(200)
    expect((await r.json()).base).toBe(`${origin}/k/${access.shareToken}`)
  })

  it('takes a /k/ prefix off the path, and puts it on the links it hands out', async () => {
    const r = await get(`/k/${access.shareToken}/api/m3u`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.url).toBe('/api/m3u')                         // routes never see the token
    expect(body.base).toBe(`${origin}/k/${access.shareToken}`)
    expect((await get(`/k/${access.shareToken}/stremio/manifest.json`)).status).toBe(200)
    expect((await get(`/k/${access.shareToken}/proxy/stream/7`)).status).toBe(200)
    expect((await get(`/k/${access.shareToken}/api/logos/render?url=x`)).status).toBe(200)
  })

  it('never puts the key itself in links it hands out', async () => {
    const r = await get(`/k/${encodeURIComponent(KEY)}/api/settings`)
    expect(r.status).toBe(200)                                // the key in the prefix is full access…
    const { base } = await r.json()
    expect(base).toBe(`${origin}/k/${access.shareToken}`)     // …but links carry the share token
    expect(base).not.toContain(encodeURIComponent(KEY))
  })

  it('gives the share token playback only, never the settings', async () => {
    expect((await get(`/k/${access.shareToken}/api/settings`)).status).toBe(403)
    expect((await get(`/k/${access.shareToken}/API/Settings`)).status).toBe(403)
    expect((await get('/api/settings', { headers: { authorization: `Bearer ${access.shareToken}` } })).status).toBe(403)
  })

  it('rejects a wrong /k/ token', async () => {
    expect((await get('/k/not-the-token/api/m3u')).status).toBe(401)
  })

  it('takes the Xtream password as the token — in the path, the query or a form', async () => {
    expect((await get('/player_api.php?username=me&password=wrong')).status).toBe(401)
    expect((await get(`/player_api.php?username=me&password=${access.shareToken}`)).status).toBe(200)
    const form = await get('/player_api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=me&password=${access.shareToken}&action=get_live_streams`,
    })
    expect(form.status).toBe(200)
    expect((await get(`/live/me/${access.shareToken}/7.ts`)).status).toBe(200)
    // Streams it hands out carry the token, for players that don't resend it.
    expect((await (await get(`/live/me/${access.shareToken}/7.ts`)).json()).base).toBe(`${origin}/k/${access.shareToken}`)
    expect((await get('/live/me/wrong/7.ts')).status).toBe(401)
    expect((await get(`/Live/me/${access.shareToken}/7.ts/`)).status).toBe(200)
  })
})

describe('access key lockout', () => {
  async function withClock() {
    const clock = { t: 0 }
    const access = createAccess({ key: KEY, logger: quiet, now: () => clock.t })
    const { server, origin } = await listen(access)
    return { clock, access, server, origin }
  }

  it('locks an address out of the key after 20 wrong keys — but links keep working', async () => {
    const { clock, access, server, origin } = await withClock()
    try {
      for (let i = 0; i < 20; i++) await fetch(`${origin}/k/wrong${i}/api/m3u`)
      expect((await fetch(`${origin}/k/${encodeURIComponent(KEY)}/api/m3u`)).status).toBe(429)
      expect((await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(429)
      // The share token is not a guessable secret: players with links carry on.
      expect((await fetch(`${origin}/k/${access.shareToken}/api/m3u`)).status).toBe(200)
      // Locked for 15 minutes from the lockout, not from the first wrong key.
      clock.t += 14 * 60 * 1000
      expect((await fetch(`${origin}/k/${encodeURIComponent(KEY)}/api/m3u`)).status).toBe(429)
      clock.t += 2 * 60 * 1000
      expect((await fetch(`${origin}/k/${encodeURIComponent(KEY)}/api/m3u`)).status).toBe(200)
    } finally {
      server.close()
    }
  })

  it('counts wrong bearer keys', async () => {
    const { server, origin } = await withClock()
    try {
      for (let i = 0; i < 20; i++) await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer wrong${i}` } })
      expect((await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(429)
    } finally {
      server.close()
    }
  })

  it('locks everyone out of the key when tries come from many made-up addresses', async () => {
    const { access, server, origin } = await withClock()
    try {
      for (let i = 0; i < 200; i++) {
        await fetch(`${origin}/k/wrong${i}/api/m3u`, { headers: { 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` } })
      }
      expect((await fetch(`${origin}/k/${encodeURIComponent(KEY)}/api/m3u`, { headers: { 'x-forwarded-for': '10.9.9.9' } })).status).toBe(429)
      expect((await fetch(`${origin}/k/${access.shareToken}/api/m3u`)).status).toBe(200)
    } finally {
      server.close()
    }
  })
})

describe('log monitor', () => {
  it('needs the key unless LOG_MONITOR_TOKEN guards it', () => {
    expect(levelFor({ path: '/api/logs', method: 'GET' })).toBe('full')
    expect(levelFor({ path: '/api/logs/stream', method: 'GET' }, { logToken: true })).toBe('open')
  })
})

describe('no access key', () => {
  it('changes nothing', async () => {
    const access = createAccess({ key: '', logger: quiet })
    const { server, origin } = await listen(access)
    try {
      expect((await fetch(`${origin}/api/settings`)).status).toBe(200)
      expect((await fetch(`${origin}/player_api.php?username=a&password=b`)).status).toBe(200)
      expect(await (await fetch(`${origin}/api/access/status`)).json()).toEqual({ enabled: false, authenticated: true })
    } finally {
      server.close()
    }
  })
})
