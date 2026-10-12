import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import vodModule from '../routes/vod.js'

const fakeVm = (overrides) => ({
  getAllItems: async () => [],
  peekListing: () => undefined,
  listingProgress: () => null,
  resolveScreenshot: () => null,
  ...overrides,
})

describe('Movies "All" when the viewer hides categories', () => {
  let server, base
  beforeAll(async () => {
    const movieCats = [{ id: '*', title: 'All' }, { id: '1', title: 'ACTION' }, { id: '2', title: 'FRENCH MOVIES' }, { id: '4', title: 'DRAMA' }]
    const titles = { 1: [{ id: 'm1', name: 'Heat' }], 2: [{ id: 'f1', name: 'Amélie' }], 4: [{ id: 'd1', name: 'Gravity' }] }
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      getShowAdult: () => true,
      getHiddenVodCategories: () => new Set(['FRENCH MOVIES']),
      vodManager: fakeVm({
        getCategories: async (t) => (t === 'series' ? [{ id: '9', title: 'Drama series' }] : movieCats),
        getAllItems: async (type, id) => titles[id] ?? [],
      }),
    }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: '.' }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })
  const get = async (q) => (await fetch(`${base}${q}`)).json()

  it("adds an All of the categories shown, in place of the portal's", async () => {
    expect((await get('/categories?type=vod')).categories.map((c) => c.id)).toEqual(['movies:all', '1', '4'])
    let r
    for (let i = 0; i < 100 && !r?.complete; i++) {
      r = await get('/listing?type=vod&category=movies:all')
      if (!r.complete) await new Promise((res) => setTimeout(res, 10))
    }
    expect(r.items.map((x) => x.id)).toEqual(['m1', 'd1'])   // nothing French
  })
})
