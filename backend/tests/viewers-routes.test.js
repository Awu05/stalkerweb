import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import ViewersManager from '../viewers/ViewersManager.js'
import { createViewerContext } from '../lib/viewerContext.js'
import viewersModule from '../routes/viewers.js'
import favoritesModule from '../routes/favorites.js'
import profilesModule from '../routes/profiles.js'
import ProfilesManager from '../profiles/ProfilesManager.js'

describe('viewers API and favorites', () => {
  let server, base, dir, viewers

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-viewer-routes-'))
    viewers = new ViewersManager(dir)
    viewers.ensureInitialized({ favorites: { channels: ['1'] } })
    const context = createViewerContext(viewers)
    // Connected, with every channel known, so the favorites list is served.
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      channelManager: {
        getChannels: () => [{ uniqueId: '1' }, { uniqueId: '2' }],
        getChannel: (id) => ({ uniqueId: String(id), name: `Ch ${id}` }),
        getProgress: () => ({ loading: false }),
        resolveLegacyId: () => null,
      },
    }
    const app = express()
    app.use(express.json())
    app.use(context.middleware)
    app.use('/api/viewers', viewersModule(viewers))
    app.use('/api/favorites', favoritesModule(viewers, appState))
    const profiles = new ProfilesManager(dir)
    profiles.create({ name: 'Portal', disabledGenres: ['Old'], disabledLanguages: ['DE'] })
    app.use('/api/profiles', profilesModule(profiles))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const call = async (method, p, body, viewer) => {
    const headers = { 'Content-Type': 'application/json', ...(viewer ? { 'X-Viewer': viewer } : {}) }
    const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() }
  }

  it('lists, creates, renames and deletes viewers', async () => {
    const created = await call('POST', '/api/viewers', { name: 'Andy' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ name: 'Andy' })
    expect(Object.keys(created.body).sort()).toEqual(['color', 'id', 'name'])

    const list = await call('GET', '/api/viewers')
    expect(list.body.viewers.map((v) => v.name)).toEqual(['Default', 'Andy'])

    expect((await call('PUT', `/api/viewers/${created.body.id}`, { name: 'Andrew' })).body.name).toBe('Andrew')
    expect((await call('POST', '/api/viewers', { name: 'andrew' })).status).toBe(409)
    expect((await call('POST', '/api/viewers', { name: '' })).status).toBe(400)
    expect((await call('DELETE', '/api/viewers/view_missing')).status).toBe(404)
    expect((await call('DELETE', `/api/viewers/${created.body.id}`)).body).toEqual({ success: true })
  })

  it('refuses to delete the last viewer', async () => {
    const only = (await call('GET', '/api/viewers')).body.viewers
    expect(only.length).toBe(1)
    const r = await call('DELETE', `/api/viewers/${only[0].id}`)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/last viewer/)
  })

  it('reads and saves the current viewer\'s filters', async () => {
    const sam = (await call('POST', '/api/viewers', { name: 'Sam' })).body
    expect((await call('GET', '/api/viewers/me')).body).toMatchObject({ name: 'Default', isDefault: true })
    const saved = await call('PUT', '/api/viewers/me/filters', { disabledGenres: ['Sports'], showAdult: true }, sam.id)
    expect(saved.body).toMatchObject({ id: sam.id, isDefault: false, disabledGenres: ['Sports'], showAdult: true })
    expect((await call('GET', '/api/viewers/me')).body.disabledGenres).toEqual([])
    expect((await call('PUT', '/api/viewers/me/filters', { showAdult: 'yes' }, sam.id)).status).toBe(400)
  })

  it('tells a device whose viewer was deleted, instead of using the default viewer\'s data', async () => {
    const before = viewers.getDefault().favorites.channels.slice()
    const me = await call('GET', '/api/viewers/me', null, 'view_deleted')
    expect(me.status).toBe(409)
    expect(me.body.viewerGone).toBe(true)
    expect((await call('PUT', '/api/viewers/me/filters', { showAdult: true }, 'view_deleted')).status).toBe(409)
    expect((await call('POST', '/api/favorites/channels', { uniqueId: '9' }, 'view_deleted')).status).toBe(409)
    expect(viewers.getDefault().favorites.channels).toEqual(before)
    expect(viewers.getDefault().showAdult).toBe(false)
    // Naming no viewer is still fine (old clients, the Android app).
    expect((await call('GET', '/api/viewers/me')).status).toBe(200)
  })

  it('reports the viewer\'s filters on portal profiles, for the Android app', async () => {
    await call('PUT', '/api/viewers/me/filters', { disabledGenres: ['Sports'], disabledLanguages: [] })
    const p = (await call('GET', '/api/profiles')).body.profiles[0]
    expect(p).toMatchObject({ name: 'Portal', disabledGenres: ['Sports'], disabledLanguages: [] })
  })

  it('keeps favorites apart per viewer, and old clients get the default viewer\'s', async () => {
    const kim = (await call('POST', '/api/viewers', { name: 'Kim' })).body
    await call('POST', '/api/favorites/channels', { uniqueId: '2' }, kim.id)
    const kimFavs = (await call('GET', '/api/favorites', null, kim.id)).body.channels.map((c) => c.uniqueId)
    const defaultFavs = (await call('GET', '/api/favorites')).body.channels.map((c) => c.uniqueId)
    expect(kimFavs).toEqual(['2'])
    expect(defaultFavs).toEqual(['1'])
  })
})

describe('portal profile edits', () => {
  it('keep the filters a profile held before viewers existed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-profile-edit-'))
    const viewers = new ViewersManager(dir)
    viewers.ensureInitialized({})
    viewers.setFilters(viewers.getDefault().id, { disabledGenres: ['Sports'] })
    const profiles = new ProfilesManager(dir)
    const p = profiles.create({ name: 'Portal', disabledGenres: ['Old'], disabledLanguages: ['DE'] })
    const context = createViewerContext(viewers)
    const app = express()
    app.use(express.json())
    app.use(context.middleware)
    app.use('/api/profiles', profilesModule(profiles))
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/profiles`
      // The editor sends back what it was given, the viewer's filters included.
      const shown = (await (await fetch(base)).json()).profiles[0]
      await fetch(`${base}/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...shown, name: 'Renamed' }) })
      expect(profiles.get(p.id)).toMatchObject({ name: 'Renamed', disabledGenres: ['Old'], disabledLanguages: ['DE'] })
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
