import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { vodLayout, isMixedCategory } from '../lib/seriesCategories.js'
import { createCatalog } from '../lib/catalog.js'
import vodModule from '../routes/vod.js'

// A portal with no series section: shows sit in movie categories named for them.
const cats = [
  { id: '1', title: 'ACTION MOVIES' }, { id: '2', title: 'TV SHOWS' }, { id: '3', title: 'ANIME MOVIES/SERIES' },
]
const lists = {
  1: [{ id: 'm1', name: 'Heat', isSeries: false }],
  2: [{ id: 's1', name: 'Bluey', isSeries: false }, { id: 's2', name: 'Cheers', isSeries: false }],
  3: [{ id: 'a1', name: 'Akira', isSeries: false }, { id: 'a2', name: 'Naruto', isSeries: true }],
}
const fakeVm = (overrides = {}) => {
  const cache = new Map()
  return {
    getCategories: async (t) => { if (t === 'series') throw new Error('no series module'); return cats },
    getAllItems: async (type, id) => { await new Promise((r) => setTimeout(r, 10)); cache.set(id, lists[id] ?? []); return lists[id] ?? [] },
    peekAllItems: (type, id) => cache.get(id),
    peekListing: (type, id) => (cache.has(id) ? { items: cache.get(id), complete: true } : undefined),
    listingProgress: () => null,
    resolveScreenshot: () => null,
    ...overrides,
  }
}

describe('vodLayout', () => {
  it('keeps a series section it has seen when the portal stumbles once', async () => {
    let fail = false
    const vm = { getCategories: async (t) => { if (t !== 'series') return cats; if (fail) throw new Error('429'); return [{ id: '9', title: 'Drama' }] } }
    expect((await vodLayout(vm)).seriesType).toBe('series')
    fail = true
    const l = await vodLayout(vm)
    expect(l).toMatchObject({ seriesType: 'series', byName: false })
    expect(l.series.map((c) => c.id)).toEqual(['9'])
  })

  it('tells a mixed category from a show one', () => {
    expect(isMixedCategory({ title: 'ANIME MOVIES/SERIES' })).toBe(true)
    expect(isMixedCategory({ title: 'TV SHOWS' })).toBe(false)
  })
})

describe('the catalog on a portal without a series section', () => {
  const catalog = () => createCatalog({ client: { getBasePath: () => 'http://p/' }, vodManager: fakeVm(), getShowAdult: () => true }, { allTitlesWaitMs: 2000 })

  it('lists every show while every movie is being read at the same time', async () => {
    const c = catalog()
    const [movies, shows] = await Promise.all([c.listMovies(), c.listShows()])
    expect(shows.map((r) => r.item.id).sort()).toEqual(['a2', 's1', 's2'])
    expect(movies.map((r) => r.item.id).sort()).toEqual(['a1', 'm1'])
  })

  it('keeps only the flagged shows of a category named for movies and shows', async () => {
    const shows = await catalog().listShows('3')
    expect(shows.map((r) => r.item.id)).toEqual(['a2'])
  })
})

describe('/api/vod on a portal without a series section', () => {
  let server, base
  beforeAll(async () => {
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      getShowAdult: () => false,
      vodManager: fakeVm({
        getCategories: async (t) => { if (t === 'series') throw new Error('none'); return [...cats, { id: '7', title: 'ADULT SERIES' }, { id: '8', title: 'BROKEN SHOWS' }] },
        getAllItems: async (type, id) => {
          if (id === '8') throw new Error('portal timeout')
          if (id === '7') return [{ id: 'x', name: 'Adult show' }]
          await new Promise((r) => setTimeout(r, 5))
          return lists[id] ?? []
        },
      }),
    }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: '.' }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod`
  })
  afterAll(() => { server.closeAllConnections(); server.close() })
  const get = async (q) => (await fetch(`${base}${q}`)).json()

  it('leaves adult categories out of Series and its "All"', async () => {
    const { categories } = await get('/categories?type=series')
    expect(categories.map((c) => c.title)).toEqual(['All', 'TV SHOWS', 'ANIME MOVIES/SERIES', 'BROKEN SHOWS'])
  })

  it('pages through Series "All" on /items, as the Android app does', async () => {
    let r
    for (let i = 0; i < 100; i++) {
      r = await get('/items?type=series&category=series:all&page=1')
      if (r.totalPages === 1) break
      await new Promise((res) => setTimeout(res, 10))
    }
    expect(r.totalPages).toBe(1)
    expect(r.items.map((x) => x.id)).toEqual(['s1', 's2', 'a1', 'a2'])
  })

  it('says when a category could not be read instead of asking forever', async () => {
    await get('/listing?type=series&category=8')
    await new Promise((res) => setTimeout(res, 20))
    const r = await get('/listing?type=series&category=8')
    expect(r).toMatchObject({ complete: true, partial: true })
    expect(r.error).toMatch(/portal timeout/)
  })
})
