import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import settingsModule from '../routes/settings.js'

describe('subtitle settings', () => {
  let server, base, dir
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sub-settings-'))
    const app = express()
    app.use(express.json())
    app.use('/api/settings', settingsModule({ dataDir: dir, downloadDir: dir }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/settings`
  })
  afterAll(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const post = (body) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const get = async () => (await fetch(base)).json()

  it('never sends a saved key or password back — only that one is saved, and its last characters', async () => {
    await post({ subtitle_provider: 'wyzie', wyzie_api_key: ' wyz-secret-1234 ', opensubtitles_api_key: 'os-secret-abcd', opensubtitles_password: 'pw' })
    const s = await get()
    expect(s).toMatchObject({ subtitle_provider: 'wyzie', wyzie_key_hint: '…1234', opensubtitles_key_hint: '…abcd', opensubtitles_password_set: true })
    expect(JSON.stringify(s)).not.toMatch(/secret|"pw"/)
  })

  it('keeps a saved key when it is left blank, and removes it with null', async () => {
    await post({ wyzie_api_key: '' })
    expect((await get()).wyzie_key_hint).toBe('…1234')
    await post({ wyzie_api_key: null })
    expect((await get()).wyzie_key_hint).toBe('')
  })
})
