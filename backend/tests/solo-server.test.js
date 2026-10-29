import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import process from 'process'
import { fileURLToPath } from 'url'

// The real server (server.js) in Solo, as the app starts it: the cast
// listener is wired in — it starts when a cast link is asked for, and stops
// once nothing was asked of it for CAST_IDLE_MS — and /api/health proves the
// key to the app.
const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js')
const KEY = 'correct horse battery'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

// Whether something listens on 127.0.0.1:port.
const listening = (port) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => { c.destroy(); resolve(true) })
  c.on('error', () => resolve(false))
})

describe('the Solo server, started as the app starts it', () => {
  let child, base, dataDir
  const auth = { Authorization: `Bearer ${KEY}` }

  beforeAll(async () => {
    const port = await freePort()
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-solo-'))
    child = spawn(process.execPath, [serverJs], {
      env: { ...process.env, SOLO: '1', PORT: String(port), DATA_DIR: dataDir, ACCESS_KEY: KEY, CAST_IDLE_MS: '400' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* not up yet */ }
      await wait(100)
    }
    throw new Error('the server never answered')
  }, 30_000)

  afterAll(() => {
    child?.kill()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('proves it holds the key on /api/health?nonce=, and says nothing of it without one', async () => {
    const nonce = crypto.randomBytes(18).toString('base64url')
    const h = await (await fetch(`${base}/api/health?nonce=${nonce}`)).json()
    expect(h.proof).toBe(crypto.createHmac('sha256', KEY).update(`solo-health:${nonce}`).digest('hex'))
    expect((await (await fetch(`${base}/api/health`)).json()).proof).toBeUndefined()
  })

  it('starts the cast listener for a cast link and stops it once nothing is asked of it', async () => {
    expect((await fetch(`${base}/api/solo/network`, {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ lanHost: '127.0.0.1' }),
    })).status).toBe(204)
    const link = await (await fetch(`${base}/api/stream/1/cast`, { headers: auth })).json()
    expect(link.reachable).toBe(true)
    const lan = new URL(link.url)
    const lanPort = Number(lan.port)
    expect(lanPort).not.toBe(Number(new URL(base).port))
    expect(await listening(lanPort)).toBe(true)
    // Only the cast stream there: the API is a 404, whatever the key.
    expect((await fetch(`${lan.origin}/api/settings`, { headers: auth })).status).toBe(404)
    await wait(1200)
    expect(await listening(lanPort)).toBe(false)
    // The next cast link starts it again.
    const again = await (await fetch(`${base}/api/stream/1/cast`, { headers: auth })).json()
    expect(again.reachable).toBe(true)
    expect(await listening(Number(new URL(again.url).port))).toBe(true)
  }, 15_000)
})
