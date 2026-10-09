import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import ViewersManager from '../viewers/ViewersManager.js'
import WatchStore from '../viewers/WatchStore.js'
import { createViewerContext } from '../lib/viewerContext.js'
import vodModule from '../routes/vod.js'

describe('/api/vod/watch', () => {
  let server, base, dir, andy
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-watch-routes-'))
    const viewers = new ViewersManager(dir)
    viewers.ensureInitialized({})
    andy = viewers.create({ name: 'Andy' }).id
    const appState = { client: { getBasePath: () => 'http://portal/c/' }, sessionManager: { isAuthenticated: () => true } }
    const app = express()
    app.use(express.json())
    app.use(createViewerContext(viewers).middleware)
    app.use('/api/vod', vodModule(appState, { downloadDir: dir }, { watchStore: new WatchStore(dir) }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod/watch`
  })
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const call = async (method, p, body, viewer) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(viewer ? { 'X-Viewer': viewer } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() }
  }

  it("records what a viewer watches, apart from other viewers, on any device", async () => {
    const saved = await call('PUT', '', { key: '100', title: 'Heat', position: 600, duration: 6000, params: 'videoId=100' }, andy)
    expect(saved.body.history[0]).toMatchObject({ id: '100', title: 'Heat' })
    expect((await call('GET', '', null, andy)).body.progress.map((e) => e.key)).toEqual(['100'])
    expect((await call('GET', '')).body.history).toEqual([])          // the default viewer's
  })

  it('removes a title and clears the history', async () => {
    await call('PUT', '', { key: '200', title: 'Alien', position: 5900, duration: 6000 }, andy)
    expect((await call('DELETE', '/history/100', null, andy)).body.history.map((e) => e.id)).toEqual(['200'])
    const cleared = await call('DELETE', '/history', null, andy)
    expect(cleared.body).toMatchObject({ history: [], watched: ['200'] })
  })

  it('keeps My List per viewer: add, complete, move back, remove', async () => {
    const added = await call('PUT', '/list', { id: '300', name: 'Arrival', year: '2016', isSeries: false }, andy)
    expect(added.body.list[0]).toMatchObject({ id: '300', item: { name: 'Arrival' }, completedAt: null })
    expect((await call('GET', '')).body.list).toEqual([])
    expect((await call('PUT', '/list/300/completed', { completed: true }, andy)).body.list[0].completedAt).toEqual(expect.any(Number))
    expect((await call('PUT', '/list/300/completed', { completed: false }, andy)).body.list[0].completedAt).toBe(null)
    expect((await call('DELETE', '/list/300', null, andy)).body.list).toEqual([])
  })

  it('refuses a deleted viewer rather than writing to the default one', async () => {
    expect((await call('PUT', '', { key: '1', position: 600, duration: 6000 }, 'view_gone')).status).toBe(409)
  })
})
