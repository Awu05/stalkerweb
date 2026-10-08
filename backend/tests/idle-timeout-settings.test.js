import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import settingsModule from '../routes/settings.js'
import { parseIdleMinutes, parseIdleEnv } from '../lib/idleTimeout.js'

describe('parseIdleMinutes', () => {
  it('accepts whole minutes including 0 (never)', () => {
    expect(parseIdleMinutes('45')).toBe(45)
    expect(parseIdleMinutes(0)).toBe(0)
  })

  it('falls back on missing or invalid values', () => {
    expect(parseIdleMinutes(undefined, 30)).toBe(30)
    expect(parseIdleMinutes('', 30)).toBe(30)
    expect(parseIdleMinutes('abc', 30)).toBe(30)
    expect(parseIdleMinutes(-5, 30)).toBe(30)
    expect(parseIdleMinutes(1.5, 30)).toBe(30)
    expect(parseIdleMinutes(999999, 30)).toBe(30)
  })
})

describe('parseIdleEnv', () => {
  it('reads plain minutes without a warning', () => {
    expect(parseIdleEnv('45')).toEqual({ minutes: 45, warning: null })
    expect(parseIdleEnv(undefined)).toEqual({ minutes: 30, warning: null })
  })

  it('reads a leading number, and says so', () => {
    expect(parseIdleEnv('45m')).toMatchObject({ minutes: 45, warning: expect.stringContaining('45') })
    expect(parseIdleEnv('1.5').minutes).toBe(1)
  })

  it('treats more than a week as never, and anything unreadable as the default — with a warning', () => {
    expect(parseIdleEnv('100000')).toMatchObject({ minutes: 0, warning: expect.stringContaining('never') })
    expect(parseIdleEnv('abc')).toMatchObject({ minutes: 30, warning: expect.any(String) })
  })
})

describe('settings route: idle_timeout_minutes', () => {
  let server, base, dataDir, appState, applied

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-idle-'))
    appState = {
      idleTimeoutMs: 30 * 60_000,
      idleTimeoutDefaultMinutes: 30,
      setIdleTimeoutMinutes: (m) => { applied.push(m); appState.idleTimeoutMs = m * 60_000 },
    }
    const app = express()
    app.use(express.json())
    app.use('/api/settings', settingsModule({ dataDir, downloadDir: '/data/downloads' }, appState))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}/api/settings`
  })

  afterAll(() => { server?.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  beforeEach(() => { applied = [] })

  const post = (body) => fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  it('reports the effective timeout and the env default', async () => {
    const s = await (await fetch(base)).json()
    expect(s.idle_timeout_minutes).toBe(30)
    expect(s.idle_timeout_default).toBe(30)
  })

  it('saves and applies a new timeout immediately', async () => {
    expect((await post({ idle_timeout_minutes: 90 })).status).toBe(200)
    expect(applied).toEqual([90])
    expect((await (await fetch(base)).json()).idle_timeout_minutes).toBe(90)
  })

  it('accepts 0 to disable auto-disconnect', async () => {
    expect((await post({ idle_timeout_minutes: 0 })).status).toBe(200)
    expect(applied).toEqual([0])
    expect((await (await fetch(base)).json()).idle_timeout_minutes).toBe(0)
  })

  it('rejects invalid values without applying them', async () => {
    expect((await post({ idle_timeout_minutes: -1 })).status).toBe(400)
    expect((await post({ idle_timeout_minutes: 'soon' })).status).toBe(400)
    expect(applied).toEqual([])
  })

  it('leaves the timeout alone when saving other settings', async () => {
    await post({ show_adult: true })
    expect(applied).toEqual([])
  })
})
