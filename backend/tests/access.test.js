import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { createAccess } from '../lib/access.js'
import { baseUrl } from '../lib/publicUrl.js'

const KEY = 'correct horse battery'
const quiet = { info: () => {}, warn: () => {} }

// A small app with the access middleware in front of stand-ins for each kind
// of route; each answers with the link base it would hand out.
function appWith(access) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(access.stripPrefix)
  app.use(express.json())
  app.use('/api/access', access.routes())
  app.use(access.gate)
  const echo = (req, res) => res.json({ base: baseUrl(req), url: req.originalUrl })
  app.get('/api/health', echo)
  app.get('/api/settings', echo)
  app.get('/api/m3u', echo)
  app.get('/api/logos/render', echo)
  app.get('/proxy/stream/:id', echo)
  app.get('/stremio/manifest.json', echo)
  app.get('/player_api.php', echo)
  app.get('/live/:user/:pass/:file', echo)
  app.get('/', (_req, res) => res.type('html').send('<html>app</html>'))
  return app
}

describe('access key', () => {
  let server, origin, access
  const get = (path, opts = {}) => fetch(origin + path, opts)

  beforeAll(async () => {
    access = createAccess({ key: KEY, logger: quiet })
    server = appWith(access).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    origin = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server.close())

  it('leaves the health check and the web app itself open', async () => {
    expect((await get('/api/health')).status).toBe(200)
    expect((await get('/')).status).toBe(200)
    expect(await (await get('/api/access/status')).json()).toEqual({ enabled: true, authenticated: false })
  })

  it('refuses the API, streams and playlists without the key', async () => {
    for (const p of ['/api/settings', '/api/m3u', '/proxy/stream/7', '/stremio/manifest.json', '/player_api.php']) {
      expect((await get(p)).status, p).toBe(401)
    }
    expect(await (await get('/api/settings')).json()).toMatchObject({ accessRequired: true })
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

  it('accepts the key as a bearer token', async () => {
    expect((await get('/api/settings', { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200)
  })

  it('takes a /k/ prefix off the path, and puts it on the links it hands out', async () => {
    const r = await get(`/k/${access.shareToken}/api/m3u`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.url).toBe('/api/m3u')                         // routes and logs never see the token
    expect(body.base).toBe(`${origin}/k/${access.shareToken}`)
    expect((await get(`/k/${access.shareToken}/stremio/manifest.json`)).status).toBe(200)
    expect((await get(`/k/${access.shareToken}/proxy/stream/7`)).status).toBe(200)
    expect((await get(`/k/${access.shareToken}/api/logos/render?url=x`)).status).toBe(200)
  })

  it('gives the share token playback only, never the settings', async () => {
    expect((await get(`/k/${access.shareToken}/api/settings`)).status).toBe(403)
    expect((await get('/api/settings', { headers: { authorization: `Bearer ${access.shareToken}` } })).status).toBe(403)
    // The key itself in the prefix is full access (the Android app).
    expect((await get(`/k/${encodeURIComponent(KEY)}/api/settings`)).status).toBe(200)
  })

  it('rejects a wrong /k/ token', async () => {
    expect((await get('/k/not-the-token/api/m3u')).status).toBe(401)
  })

  it('takes the Xtream password as the token', async () => {
    expect((await get('/player_api.php?username=me&password=wrong')).status).toBe(401)
    const r = await get(`/player_api.php?username=me&password=${access.shareToken}`)
    expect(r.status).toBe(200)
    expect((await get(`/live/me/${access.shareToken}/7.ts`)).status).toBe(200)
    // Streams it hands out carry the token, for players that don't resend it.
    expect((await (await get(`/live/me/${access.shareToken}/7.ts`)).json()).base).toBe(`${origin}/k/${access.shareToken}`)
    expect((await get('/live/me/wrong/7.ts')).status).toBe(401)
  })
})

describe('access key lockout', () => {
  it('locks an address out after repeated wrong keys', async () => {
    let t = 0
    const access = createAccess({ key: KEY, logger: quiet, now: () => t })
    const server = appWith(access).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      for (let i = 0; i < 20; i++) await fetch(`${origin}/k/wrong${i}/api/m3u`)
      // Even the right token is refused while locked out…
      expect((await fetch(`${origin}/k/${access.shareToken}/api/m3u`)).status).toBe(429)
      // …until the window passes.
      t += 16 * 60 * 1000
      expect((await fetch(`${origin}/k/${access.shareToken}/api/m3u`)).status).toBe(200)
    } finally {
      server.close()
    }
  })
})

describe('no access key', () => {
  it('changes nothing', async () => {
    const access = createAccess({ key: '', logger: quiet })
    const server = appWith(access).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      expect((await fetch(`${origin}/api/settings`)).status).toBe(200)
      expect((await fetch(`${origin}/player_api.php?username=a&password=b`)).status).toBe(200)
      expect(await (await fetch(`${origin}/api/access/status`)).json()).toEqual({ enabled: false, authenticated: true })
    } finally {
      server.close()
    }
  })
})
