import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import VodManager from '../stalker/VodManager.js'
import vodModule from '../routes/vod.js'

// A portal category of 30 titles, 14 to a page.
const all = Array.from({ length: 30 }, (_, i) => ({
  id: String(i + 1), name: `Title ${i + 1}`, genres_str: i % 2 ? 'Action, Drama' : 'Comedy',
  rating_imdb: i === 0 ? '7.4' : '', year: String(2000 + i), hd: i % 3 === 0 ? 1 : 0, added: `2026-10-0${(i % 9) + 1} 12:00:00`,
}))
const portal = () => ({
  _stalkerCall: async ({ p = '1', category }) => {
    if (category !== '5') return { js: { data: [], total_items: 0, max_page_items: 14 } }
    const page = parseInt(p, 10)
    await new Promise((r) => setTimeout(r, 5))
    return { js: { data: all.slice((page - 1) * 14, page * 14), total_items: all.length, max_page_items: 14 } }
  },
})

describe('VOD titles', () => {
  it('keep the genres and IMDb rating the portal sends', async () => {
    const vm = new VodManager(portal(), { pageGapMs: 0 })
    const { items } = await vm.getItems({ categoryId: '5' })
    expect(items[0]).toMatchObject({ genres: ['Comedy'], rating: 7.4 })
    expect(items[1]).toMatchObject({ genres: ['Action', 'Drama'], rating: 0 })
  })
})

describe('GET /api/vod/listing', () => {
  let server, base
  beforeAll(async () => {
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      vodManager: Object.assign(new VodManager(portal(), { pageGapMs: 10 }), { resolveScreenshot: () => null }),
    }
    appState.vodManager.getCategories = async (t) => { if (t === 'series') throw new Error('none'); return [{ id: '5', title: 'Action' }] }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: '.' }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod/listing?type=vod&category=5`
  })
  afterAll(() => server.close())

  it('hands back the whole category as it is read, a part at a time, then all of it', async () => {
    const seen = []
    let r
    for (let i = 0; i < 100; i++) {
      r = await (await fetch(`${base}&from=${seen.length}`)).json()
      seen.push(...r.items)
      if (r.complete) break
      await new Promise((res) => setTimeout(res, 10))
    }
    expect(r.complete).toBe(true)
    expect(r.total).toBe(30)
    expect(seen.map((x) => x.id)).toEqual(all.map((x) => x.id))   // each title once, in order
  })

  it('serves a read category from the cache, all at once', async () => {
    const r = await (await fetch(`${base}&from=0`)).json()
    expect(r).toMatchObject({ complete: true, total: 30, loaded: 30 })
    expect(r.items).toHaveLength(30)
  })
})
