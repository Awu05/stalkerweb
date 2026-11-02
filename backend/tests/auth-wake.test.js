import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const authModule = require('../routes/auth.js')

// GET /api/auth/status?wake=1: someone opened the app or signed in — the
// session the idle timeout dropped comes back. The apps' polling (no wake)
// never reconnects, or the session would never go idle.
describe('/api/auth/status wake', () => {
  let server, base, dir, appState, wakes, fail
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wake-'))
    appState = {}
    const { authRoutes } = authModule(appState, { dataDir: dir })
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRoutes)
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/auth/status`
  })
  afterAll(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  beforeEach(() => {
    wakes = 0
    fail = null
    appState.sessionManager = null
    // What server.js's ensureSession does: reconnect to the saved portal.
    appState.ensureSession = async () => {
      wakes++
      if (fail) throw new Error(fail)
      appState.sessionManager = { isAuthenticated: () => true, getProfile: () => ({}), _watchdog: null }
      return true
    }
  })
  const get = async (q = '') => (await fetch(base + q)).json()

  it('reconnects to the last portal when the app is opened', async () => {
    const s = await get('?wake=1')
    expect(wakes).toBe(1)
    expect(s.connected).toBe(true)
  })

  it('a plain status check never reconnects', async () => {
    const s = await get()
    expect(wakes).toBe(0)
    expect(s.connected).toBe(false)
  })

  it('does nothing when already connected', async () => {
    appState.sessionManager = { isAuthenticated: () => true, getProfile: () => ({}), _watchdog: null }
    await get('?wake=1')
    expect(wakes).toBe(0)
  })

  it("says so when the reconnect fails, and still answers", async () => {
    fail = 'portal unreachable'
    const s = await get('?wake=1')
    expect(s.connected).toBe(false)
    expect(s.wakeError).toBe('portal unreachable')
  })
})
