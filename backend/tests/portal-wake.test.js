import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const authModule = require('../routes/auth.js')
const channelRoutes = require('../routes/channels.js')
const sessionMiddleware = require('../middleware/session.js')
const { installPortalSession, dropSession } = require('../lib/portalSession.js')
const CacheManager = require('../cache/CacheManager.js')
const SessionManager = require('../stalker/SessionManager.js')

// The idle timeout drops the portal session: the server is asleep. Real use —
// a data request through the session guard — wakes it (the last portal that
// worked); the status route and anything a timer or poll sends
// (X-Background: 1) never do, so the idle disconnect still happens. A manual
// disconnect is not asleep.

const MAC = '00:1A:79:12:34:56'
const A = 'http://a.portal.example/c/'
const B = 'http://b.portal.example/c/'
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const deferred = () => { let open; const p = new Promise((r) => { open = r }); return { p, open } }
const settled = async (p) => { let done = false; p.then(() => { done = true }, () => { done = true }); await tick(60); return done }

const running = []
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop()
})

function fakeSessionManager() {
  const sm = { authenticated: true, destroyed: 0, isAuthenticated: () => sm.authenticated, getProfile: () => ({}), destroy: () => { sm.destroyed++; sm.authenticated = false }, _watchdog: null }
  return sm
}

// One server: the real auth routes, guard and idle/wake logic, with the portal
// handshake (connectPortalOnce) replaced by a fake that counts its calls.
// s.lists: the first channel/genre load after a connect (resolves at once unless set).
async function start(dir, clock, opts = {}) {
  const appState = {}
  const s = { appState, calls: [], bodies: [], fail: null, gate: null, lists: null }
  const connectOnce = async (body) => {
    s.calls.push(body.portal)
    s.bodies.push(body)
    // What the real one does before authenticating: the old session goes, the attempted portal is saved.
    dropSession(appState)
    const cache = new CacheManager(dir)
    cache.save({ ...(cache.load() || {}), portal: body.portal, mac: body.mac })
    if (s.gate) await s.gate
    if (s.fail) throw new Error(s.fail)
    appState.sessionManager = fakeSessionManager()
    appState.channelManager = {}
    appState.channelsReady = s.lists ? s.lists.p : Promise.resolve()
    return { token: 't', profile: {} }
  }
  const { authRoutes, connectPortal } = authModule(appState, { dataDir: dir }, { connectOnce })
  appState.connectPortal = connectPortal
  s.session = installPortalSession(appState, { dataDir: dir, idleTimeoutMs: 30 * 60_000, now: () => clock.t, reauthWaitMs: 100, listsWaitMs: 300, ...opts })
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRoutes)
  app.get('/api/data', sessionMiddleware(appState), (_req, res) => res.json({ ok: true }))
  app.get('/api/stream-events', sessionMiddleware(appState, { wake: false }), (_req, res) => res.json({ ok: true }))
  const server = await new Promise((r) => { const h = app.listen(0, '127.0.0.1', () => r(h)) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  s.get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, body: await r.json() } }
  s.send = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    const json = await r.json()
    return { status: r.status, body: json, text: JSON.stringify(json) }
  }
  s.status = async () => (await s.get('/auth/status')).body
  s.saved = () => new CacheManager(dir).load()
  s.stop = async () => { clearTimeout(appState._idleTimer); server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  running.push(s)
  return s
}

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wake-'))
  new CacheManager(dir).save({ portal: A, mac: MAC })
  return dir
}

describe('portal wake', () => {
  it('the idle timeout leaves the server asleep, not disconnected', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    expect((await s.status()).connected).toBe(true)
    s.session.idleDisconnect()
    const st = await s.status()
    expect(st).toMatchObject({ connected: false, asleep: true, portal: A, mac: MAC })
    expect(st.wakeError).toBeUndefined()
  })

  it('asleep only with something to wake to: the working connection deleted, the idle drop is plain disconnected', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    expect((await s.send('PUT', '/auth/config', { portal: '', mac: '' })).status).toBe(200)   // deleting A, the one that works
    expect(s.saved().last_good).toBeUndefined()
    s.session.idleDisconnect()
    expect(await s.status()).toMatchObject({ connected: false, asleep: false })
    expect((await s.get('/data')).status).toBe(503)
    expect(s.calls).toEqual([A])
  })

  it('a data request wakes it and succeeds — once the channel and genre lists are in', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    s.lists = deferred()
    const r = s.get('/data')
    expect(await settled(r)).toBe(false)   // connected, the lists still loading
    s.lists.open()
    expect(await r).toEqual({ status: 200, body: { ok: true } })
    expect(s.calls).toEqual([A, A])
    expect(await s.status()).toMatchObject({ connected: true, asleep: false })
  })

  it('a list load that never ends holds the wake only so long', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    s.lists = deferred()   // never opened
    expect((await s.get('/data')).status).toBe(200)
  })

  it('the status route and anything a timer or poll sends never wake it', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    await s.status()
    expect((await s.get('/stream-events')).status).toBe(503)
    expect((await s.get('/data', { 'X-Background': '1' })).status).toBe(503)
    expect(s.calls).toEqual([A])
    expect(await s.status()).toMatchObject({ connected: false, asleep: true })
  })

  it('a manual disconnect is not asleep: nothing wakes it, not even a restart', async () => {
    const clock = { t: 1_000_000 }
    const dir = dataDir()
    const s = await start(dir, clock)
    await s.session.autoConnect()
    expect((await s.send('DELETE', '/auth/disconnect')).status).toBe(200)
    expect(await s.status()).toMatchObject({ connected: false, asleep: false })
    expect((await s.get('/data')).status).toBe(503)
    await expect(s.appState.ensureSession()).rejects.toThrow()
    expect(s.calls).toEqual([A])

    await s.stop()
    const again = await start(dir, clock)
    await again.session.autoConnect()
    expect(again.calls).toEqual([])
    expect(await again.status()).toMatchObject({ connected: false, asleep: false })
    expect((await again.get('/data')).status).toBe(503)
    expect(again.calls).toEqual([])
  })

  it('a disconnect during a wake cancels it: no session, the flag kept', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    const gate = deferred()
    s.gate = gate.p
    const data = s.get('/data')
    await tick(50)
    expect((await s.send('DELETE', '/auth/disconnect')).status).toBe(200)
    gate.open()
    expect((await data).status).toBe(503)
    expect(s.appState.sessionManager).toBeNull()
    expect(s.saved()).toMatchObject({ user_disconnected: true, last_good: { portal: A } })
    expect(await s.status()).toMatchObject({ connected: false, asleep: false })
    expect(s.appState.connecting).toBeFalsy()
  })

  it('a wake during a running connect joins it (one handshake)', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    const gate = deferred()
    s.gate = gate.p
    const startup = s.session.autoConnect()   // Solo's cold start: the auto-connect still running
    const data = s.get('/data')
    await tick(50)
    gate.open()
    await startup
    expect(await data).toEqual({ status: 200, body: { ok: true } })
    expect(s.calls).toEqual([A])
  })

  it('a re-authenticating session is waited for, not replaced', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    const sm = s.appState.sessionManager
    sm.authenticated = false   // the watchdog saw the session expire; the auth checker re-authenticates
    setTimeout(() => { sm.authenticated = true }, 40)
    expect((await s.get('/data')).status).toBe(200)
    expect(s.calls).toEqual([A])
    expect(sm.destroyed).toBe(0)
    expect(s.appState.sessionManager).toBe(sm)
  })

  it('a re-auth that never comes back: one full reconnect, the old session torn down', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    const sm = s.appState.sessionManager
    sm.authenticated = false
    const [one, two] = await Promise.all([s.get('/data'), s.get('/data')])
    expect([one.status, two.status]).toEqual([200, 200])
    expect(s.calls).toEqual([A, A])
    expect(sm.destroyed).toBe(1)
    expect(s.appState.sessionManager).not.toBe(sm)
  })

  it('wakes to the last portal that worked, not a failed switch; deleting the failed one keeps it', async () => {
    const clock = { t: 1_000_000 }
    const dir = dataDir()
    const s = await start(dir, clock)
    await s.session.autoConnect()
    s.fail = 'portal B refused'
    expect((await s.send('POST', '/auth/connect', { portal: B, mac: MAC })).status).toBe(401)
    expect(await s.status()).toMatchObject({ connected: false, asleep: false })   // a failed connect the user started
    expect(s.saved().portal).toBe(B)
    expect((await s.send('PUT', '/auth/config', { portal: '', mac: '' })).status).toBe(200)   // B deleted
    expect(s.saved().last_good).toMatchObject({ portal: A, mac: MAC })

    // Restarted, the network not up yet: the startup connect fails — asleep, backing off.
    await s.stop()
    const again = await start(dir, clock)
    again.fail = 'network down'
    await again.session.autoConnect()
    expect(await again.status()).toMatchObject({ connected: false, asleep: true, portal: A, wakeError: 'network down' })
    clock.t += 61_000
    again.fail = null
    expect((await again.get('/data')).status).toBe(200)
    expect(again.calls).toEqual([A, A])
  })

  it('after a failed Reconnect, outside players still reconnect to the portal that worked', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.fail = 'portal B refused'
    expect((await s.send('POST', '/auth/connect', { portal: B, mac: MAC })).status).toBe(401)
    expect((await s.status()).asleep).toBe(false)
    s.fail = 'still down'
    await expect(s.appState.ensureSession()).rejects.toThrow('still down')
    await expect(s.appState.ensureSession()).rejects.toThrow('still down')   // backing off: no new handshake
    expect(s.calls).toEqual([A, B, A])
    clock.t += 61_000
    s.fail = null
    await expect(s.appState.ensureSession()).resolves.toBe(true)
    expect(s.calls).toEqual([A, B, A, A])
  })

  it('a failed wake backs off for 60 s, and says why', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    s.fail = 'portal unreachable'
    const first = await s.get('/data')
    expect(first.status).toBe(503)
    expect(first.body.wakeError).toBe('portal unreachable')
    clock.t += 30_000
    const second = await s.get('/data')
    expect(second.status).toBe(503)
    expect(second.body.wakeError).toBe('portal unreachable')
    expect(s.calls).toEqual([A, A])   // no second handshake
    expect(await s.status()).toMatchObject({ connected: false, asleep: true, wakeError: 'portal unreachable' })

    clock.t += 31_000
    s.fail = null
    expect((await s.get('/data')).status).toBe(200)
    expect(s.calls).toEqual([A, A, A])
    expect((await s.status()).wakeError).toBeUndefined()
  })

  it('Reconnect from asleep restarts the idle timer', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    expect(s.appState._idleTimer).toBeNull()
    expect((await s.send('POST', '/auth/reconnect')).status).toBe(200)
    expect(s.appState._idleTimer).not.toBeNull()
  })

  it('a password portal: the wake sends its password; no answer carries it', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    const r = await s.send('POST', '/auth/connect', { portal: A, mac: MAC, login: 'viewer', password: 'pw-for-tests' })
    expect(r.status).toBe(200)
    expect(r.text).not.toContain('pw-for-tests')
    expect(s.saved().last_good).toMatchObject({ login: 'viewer', password: 'pw-for-tests' })
    s.session.idleDisconnect()
    expect((await s.get('/data')).status).toBe(200)
    expect(s.bodies.at(-1)).toMatchObject({ portal: A, login: 'viewer', password: 'pw-for-tests' })
    expect(JSON.stringify(await s.status())).not.toContain('pw-for-tests')
    expect(JSON.stringify((await s.get('/auth/config')).body)).not.toContain('pw-for-tests')
  })
})

describe('dropSession', () => {
  it('tears everything down once; asleep only when told', () => {
    const sm = fakeSessionManager()
    const appState = { sessionManager: sm, client: {}, channelManager: {}, guideManager: {}, vodManager: {}, identity: {}, asleep: true, wakeError: 'x' }
    dropSession(appState)
    expect(sm.destroyed).toBe(1)
    expect(appState).toMatchObject({ sessionManager: null, client: null, channelManager: null, guideManager: null, vodManager: null, identity: null, asleep: true, wakeError: 'x' })
    dropSession(appState, { asleep: false })
    expect(appState).toMatchObject({ asleep: false, wakeError: null })
  })
})

describe('GET /api/channels/groups/all while the genres load', () => {
  it('joins the load instead of answering []', async () => {
    let groups = []
    const load = deferred()
    const appState = {
      sessionManager: fakeSessionManager(),
      channelManager: {
        getProgress: () => ({ loading: true }),
        getGroups: () => groups,
        loadGroups: () => load.p.then(() => { groups = [{ id: '1', name: 'News' }] }),
        getChannels: () => [],
      },
    }
    const app = express()
    app.use('/api/channels', channelRoutes(appState))
    const server = await new Promise((r) => { const h = app.listen(0, '127.0.0.1', () => r(h)) })
    try {
      const r = fetch(`http://127.0.0.1:${server.address().port}/api/channels/groups/all`).then((x) => x.json())
      expect(await settled(r)).toBe(false)
      load.open()
      expect(await r).toEqual({ total: 1, groups: [{ id: '1', name: 'News' }] })
    } finally {
      server.closeAllConnections(); server.close()
    }
  })
})

describe('SessionManager.destroy during authenticate', () => {
  it('starts no timers once destroyed', async () => {
    const sm = new SessionManager({ setTokenChangedCallback() {} })
    sm._doHandshake = async () => { sm.destroy() }
    sm._getProfile = async () => {}
    await sm.authenticate().catch(() => {})
    expect(sm._watchdog).toBeNull()
    expect(sm._authTimer).toBeNull()
    expect(sm.isAuthenticated()).toBe(false)
  })
})
