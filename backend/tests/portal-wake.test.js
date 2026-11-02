import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const authModule = require('../routes/auth.js')
const sessionMiddleware = require('../middleware/session.js')
const { installPortalSession } = require('../lib/portalSession.js')
const CacheManager = require('../cache/CacheManager.js')
const SessionManager = require('../stalker/SessionManager.js')

// The idle timeout drops the portal session: the server is asleep. Real use —
// a data request through the session guard — wakes it (the last portal that
// worked); the status route and the apps' polling never do, so the idle
// disconnect still happens. A manual disconnect is not asleep.

const MAC = '00:1A:79:12:34:56'
const A = 'http://a.portal.example/c/'
const B = 'http://b.portal.example/c/'
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

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
async function start(dir, clock) {
  const appState = {}
  const s = { appState, calls: [], fail: null, gate: null }
  const connectOnce = async (body) => {
    s.calls.push(body.portal)
    // What the real one does before authenticating: the old session goes, the attempted portal is saved.
    appState.sessionManager?.destroy()
    appState.sessionManager = null
    appState.channelManager = null
    const cache = new CacheManager(dir)
    cache.save({ ...(cache.load() || {}), portal: body.portal, mac: body.mac })
    if (s.gate) await s.gate
    if (s.fail) throw new Error(s.fail)
    appState.sessionManager = fakeSessionManager()
    appState.channelManager = {}
    return { token: 't', profile: {} }
  }
  const { authRoutes, connectPortal } = authModule(appState, { dataDir: dir }, { connectOnce })
  appState.connectPortal = connectPortal
  s.session = installPortalSession(appState, { dataDir: dir, idleTimeoutMs: 30 * 60_000, now: () => clock.t })
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRoutes)
  app.get('/api/data', sessionMiddleware(appState), (_req, res) => res.json({ ok: true }))
  app.get('/api/progress', sessionMiddleware(appState, { wake: false }), (_req, res) => res.json({ ok: true }))
  const server = await new Promise((r) => { const h = app.listen(0, '127.0.0.1', () => r(h)) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  s.get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, body: await r.json() } }
  s.send = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  s.status = async () => (await s.get('/auth/status')).body
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

  it('a data request wakes it and succeeds', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    const r = await s.get('/data')
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(s.calls).toEqual([A, A])
    expect(await s.status()).toMatchObject({ connected: true, asleep: false })
  })

  it("the status route and the apps' polling never wake it", async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    s.session.idleDisconnect()
    await s.status()
    expect((await s.get('/progress')).status).toBe(503)
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

  it('a wake during a running connect joins it (one handshake)', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    let open
    s.gate = new Promise((r) => { open = r })
    const startup = s.session.autoConnect()   // Solo's cold start: the auto-connect still running
    const data = s.get('/data')
    await tick(50)
    open()
    await startup
    expect(await data).toEqual({ status: 200, body: { ok: true } })
    expect(s.calls).toEqual([A])
  })

  it('never wakes while a SessionManager exists (re-authenticating)', async () => {
    const clock = { t: 1_000_000 }
    const s = await start(dataDir(), clock)
    await s.session.autoConnect()
    const sm = s.appState.sessionManager
    sm.authenticated = false   // the watchdog saw the session expire; the auth checker re-authenticates
    s.appState.asleep = true   // even if it were marked asleep
    expect((await s.get('/data')).status).toBe(503)
    await expect(s.appState.ensureSession()).rejects.toThrow()
    expect(s.calls).toEqual([A])
    expect(sm.destroyed).toBe(0)
    expect(s.appState.sessionManager).toBe(sm)
  })

  it('wakes to the last portal that worked, not a failed switch', async () => {
    const clock = { t: 1_000_000 }
    const dir = dataDir()
    const s = await start(dir, clock)
    await s.session.autoConnect()
    s.fail = 'portal B refused'
    expect((await s.send('POST', '/auth/connect', { portal: B, mac: MAC })).status).toBe(401)
    expect(await s.status()).toMatchObject({ connected: false, asleep: false })   // a failed connect the user started
    expect(new CacheManager(dir).load().portal).toBe(B)

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
