import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import vodModule from '../routes/vod.js'

describe('the Series "All" on a portal without a series section', () => {
  let server, base
  beforeAll(async () => {
    const lists = { 1: [{ id: 'a', name: 'Show A' }, { id: 'b', name: 'Show B' }], 2: [{ id: 'b', name: 'Show B' }, { id: 'c', name: 'Show C' }] }
    const read = new Map()
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      vodManager: {
        getCategories: async (t) => { if (t === 'series') throw new Error('none'); return [{ id: '*', title: 'All' }, { id: '1', title: 'TV SHOWS' }, { id: '2', title: 'KIDS SERIES' }, { id: '3', title: 'MOVIES' }] },
        getAllItems: async (type, id) => { await new Promise((r) => setTimeout(r, 5)); read.set(id, { items: lists[id] ?? [], complete: true }); return lists[id] ?? [] },
        peekListing: (type, id) => read.get(id),
        listingProgress: () => null,
        resolveScreenshot: () => null,
      },
    }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: '.' }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod/listing?type=series&category=series:all`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })   // keep-alive sockets would outlive it and reach the next test's server on a reused port

  it('lists every show of every series category once', async () => {
    let r, seen = []
    for (let i = 0; i < 50; i++) {
      r = await (await fetch(`${base}&from=${seen.length}`)).json()
      seen.push(...r.items)
      if (r.complete) break
      await new Promise((res) => setTimeout(res, 10))
    }
    expect(r.complete).toBe(true)
    expect(seen.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
})
