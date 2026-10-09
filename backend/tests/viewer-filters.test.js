import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { createViewerContext } from '../lib/viewerContext.js'
import { installViewerFilters } from '../lib/viewerFilters.js'

const all = [
  { id: 'view_def', name: 'Default', disabledGenres: [], disabledLanguages: [], showAdult: false },
  { id: 'view_andy', name: 'Andy', disabledGenres: ['Sports'], disabledLanguages: ['FR'], disabledVodCategories: ['Kids Movies'], showAdult: true },
]
const viewers = {
  get: (id) => all.find((v) => v.id === id) ?? null,
  getDefault: () => all[0],
  findByName: () => null,
}
const channels = [
  { name: 'ESPN', genre: 'Sports' },
  { name: 'TF1', genre: 'FR | General' },
  { name: 'Hot', genre: 'Adult' },
  { name: 'CNN', genre: 'News' },
]

describe('viewer filters', () => {
  let server, base
  beforeAll(async () => {
    const context = createViewerContext(viewers)
    const appState = {}
    installViewerFilters(appState, { viewers, context })
    const app = express()
    app.use(context.middleware)
    app.get('/shown', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5)) // the filter is read after an await
      res.json({
        names: channels.filter(appState.getExportFilter().keep).map((c) => c.name),
        adult: appState.getShowAdult(),
        languages: [...appState.getHiddenLanguages()],
        vod: [...appState.getHiddenVodCategories()],
        isDefault: appState.isDefaultViewer(appState.currentViewer()),
      })
    })
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server.close())

  it('uses the default viewer\'s filters when no viewer is named', async () => {
    const r = await (await fetch(`${base}/shown`)).json()
    expect(r).toEqual({ names: ['ESPN', 'TF1', 'CNN'], adult: false, languages: [], vod: [], isDefault: true })
  })

  it('uses the named viewer\'s filters', async () => {
    const r = await (await fetch(`${base}/shown?viewer=view_andy`)).json()
    expect(r.names).toEqual(['Hot', 'CNN'])
    expect(r.adult).toBe(true)
    expect(r.languages.length).toBe(1)
    expect(r.vod).toEqual(['KIDS MOVIES'])
    expect(r.isDefault).toBe(false)
  })

  it('gives each viewer its own filter key, so filtered caches are not shared', () => {
    // Outside a request: the default viewer.
    const appState = {}
    installViewerFilters(appState, { viewers, context: { current: () => all[1] } })
    const andyKey = appState.getExportFilter().key
    installViewerFilters(appState, { viewers, context: { current: () => null } })
    expect(appState.getExportFilter().key).not.toBe(andyKey)
  })
})
