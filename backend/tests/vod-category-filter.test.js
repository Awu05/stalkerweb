import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { visibleVodCategories, toCategorySet, isAllCategory } from '../lib/vodCategoryFilter.js'
import vodModule from '../routes/vod.js'

const cats = [
  { id: '*', title: 'All' },
  { id: '1', title: 'APPLE TV+ ENGLISH MOVIES' },
  { id: '2', title: 'KIDS MOVIES' },
  { id: '3', title: 'FRENCH | MOVIES' },
]

describe('visibleVodCategories', () => {
  it('leaves everything, the All category included, when nothing is hidden', () => {
    expect(visibleVodCategories(cats, {})).toEqual(cats)
  })

  it('hides categories by name, ignoring case and stray spaces', () => {
    const shown = visibleVodCategories(cats, { hiddenCategories: toCategorySet([' kids movies '])})
    expect(shown.map((c) => c.id)).toEqual(['1', '3'])
  })

  it('still honours an old hidden-languages list', () => {
    const shown = visibleVodCategories(cats, { hiddenLanguages: new Set(['FRENCH']) })
    expect(shown.map((c) => c.id)).toEqual(['1', '2'])
  })
})

describe('GET /api/vod/categories', () => {
  let server, base
  beforeAll(async () => {
    const appState = {
      sessionManager: { isAuthenticated: () => true },
      vodManager: { getCategories: async () => cats },
      getHiddenLanguages: () => new Set(),
      getHiddenVodCategories: () => toCategorySet(['KIDS MOVIES']),
    }
    const app = express()
    app.use('/api/vod', vodModule(appState, { downloadDir: '.' }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod/categories`
  })
  afterAll(() => server.close())

  it("leaves out the viewer's hidden categories", async () => {
    const { categories } = await (await fetch(base)).json()
    expect(categories.map((c) => c.id)).toEqual(['1', '3'])
  })

  it('lists every category with ?all=1, for the Settings list', async () => {
    const { categories } = await (await fetch(`${base}?all=1`)).json()
    expect(categories.map((c) => c.id)).toEqual(['*', '1', '2', '3'])
  })
})

describe('the catch-all category', () => {
  it('is recognised by its title too, whatever its id', () => {
    const odd = [{ id: '0', title: ' All ' }, { id: '1', title: 'KIDS MOVIES' }, { id: '2', title: 'ACTION' }]
    const shown = visibleVodCategories(odd, { hiddenCategories: toCategorySet(['KIDS MOVIES']) })
    expect(shown.map((c) => c.id)).toEqual(['2'])
  })

  it('is one rule, shared', () => {
    expect(isAllCategory({ id: '*', title: 'Everything' })).toBe(true)
    expect(isAllCategory({ id: '7', title: 'all' })).toBe(true)
    expect(isAllCategory({ id: '7', title: 'All Movies' })).toBe(false)
  })
})
