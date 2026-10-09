import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { splitByName, vodLayout } from '../lib/seriesCategories.js'
import vodModule from '../routes/vod.js'

// The categories of a portal with no series section — shows live among movies.
const titles = [
  'All', 'ENGLISH TV SHOWS', 'NETFLIX ENGLISH SHOWS', 'APPLE TV+ ENGLISH SHOWS', 'ENGLISH LATEST MOVIES',
  'APPLE TV+ ENGLISH MOVIES', 'ANIME MOVIES/SERIES (PG)', 'KOREAN ENGLISH DUB SERIES', 'KIDS MOVIES',
  'KIDS TV SHOWS', 'KIDS RHYMES', 'FRENCH KIDS SERIES', 'SPORTING EVENTS', 'COMEDY STAND UP', 'FRENCH TV SHOWS',
]
const cats = titles.map((title, i) => ({ id: i === 0 ? '*' : String(i), title }))
const names = (list) => list.map((c) => c.title)

describe('splitByName', () => {
  const { movies, series } = splitByName(cats)

  it('puts categories named for shows or series under Series', () => {
    expect(names(series)).toEqual([
      'ENGLISH TV SHOWS', 'NETFLIX ENGLISH SHOWS', 'APPLE TV+ ENGLISH SHOWS', 'ANIME MOVIES/SERIES (PG)',
      'KOREAN ENGLISH DUB SERIES', 'KIDS TV SHOWS', 'FRENCH KIDS SERIES', 'FRENCH TV SHOWS',
    ])
  })

  it('keeps the rest, and the ones named for both, under Movies — "TV" alone is not a show', () => {
    expect(names(movies)).toEqual([
      'All', 'ENGLISH LATEST MOVIES', 'APPLE TV+ ENGLISH MOVIES', 'ANIME MOVIES/SERIES (PG)', 'KIDS MOVIES',
      'KIDS RHYMES', 'SPORTING EVENTS', 'COMEDY STAND UP',
    ])
  })
})

describe('vodLayout', () => {
  it("uses the portal's own series section when it has one", async () => {
    const vm = { getCategories: async (t) => (t === 'series' ? [{ id: '9', title: 'Drama' }] : cats) }
    const l = await vodLayout(vm)
    expect(l).toMatchObject({ seriesType: 'series', byName: false })
    expect(names(l.series)).toEqual(['Drama'])
    expect(l.movies).toBe(cats)
  })

  it('splits the movie categories by name when the portal has no series section', async () => {
    let seriesCalls = 0
    const vm = { getCategories: async (t) => { if (t === 'series') { seriesCalls++; throw new Error('no series module') } return cats } }
    const l = await vodLayout(vm)
    expect(l).toMatchObject({ seriesType: 'vod', byName: true })
    expect(l.series.length).toBe(8)
    await vodLayout(vm)
    expect(seriesCalls).toBe(1)   // a rejecting portal isn't asked again straight away
  })

  it('leaves everything under Movies when no name says show or series', async () => {
    const plain = [{ id: '1', title: 'Action' }, { id: '2', title: 'Drama' }]
    const l = await vodLayout({ getCategories: async (t) => (t === 'series' ? [] : plain) })
    expect(l).toMatchObject({ seriesType: 'vod', byName: false, series: [] })
    expect(l.movies).toEqual(plain)
  })
})

describe('GET /api/vod on a portal without a series section', () => {
  let server, base, calls
  beforeAll(async () => {
    calls = []
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      vodManager: {
        getCategories: async (t) => { if (t === 'series') throw new Error('no series module'); return cats },
        getItems: async (args) => { calls.push(args); return { items: [], totalItems: 0, totalPages: 1, page: 1 } },
        resolveScreenshot: () => null,
      },
    }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: '.' }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod`
  })
  afterAll(() => server.close())

  it('lists the show categories under Series and the rest under Movies', async () => {
    const series = (await (await fetch(`${base}/categories?type=series`)).json()).categories
    const movies = (await (await fetch(`${base}/categories?type=vod`)).json()).categories
    expect(series.length).toBe(8)
    expect(names(movies)).not.toContain('ENGLISH TV SHOWS')
  })

  it('reads a Series category from the movie section, in the order asked for', async () => {
    await fetch(`${base}/items?type=series&category=1&sort=name`)
    await fetch(`${base}/items?type=vod&category=5`)
    expect(calls[0]).toMatchObject({ type: 'vod', categoryId: '1', sort: 'name' })
    expect(calls[1]).toMatchObject({ type: 'vod', categoryId: '5', sort: 'added' })
  })
})
