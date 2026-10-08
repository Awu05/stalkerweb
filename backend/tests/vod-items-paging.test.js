import { describe, it, expect } from 'vitest'
import VodManager from '../stalker/VodManager.js'

// A portal category of 100 titles served 14 per page (8 portal pages).
const TOTAL = 100
const PER_PAGE = 14
const fakeClient = () => {
  const client = {
    requested: [],
    _stalkerCall: async ({ p }) => {
      const n = Number(p)
      client.requested.push(n)
      const start = (n - 1) * PER_PAGE
      const data = Array.from({ length: Math.max(0, Math.min(PER_PAGE, TOTAL - start)) },
        (_, i) => ({ id: String(start + i + 1), name: `Title ${start + i + 1}` }))
      return { js: { total_items: String(TOTAL), max_page_items: String(PER_PAGE), data } }
    },
  }
  return client
}

describe('VodManager.getItems paging', () => {
  it('pages in batches with no duplicate or missing titles', async () => {
    const client = fakeClient()
    const vm = new VodManager(client)

    // Page the way the web and Android clients do: page+1 until page === totalPages.
    const ids = []
    let page = 1, totalPages
    do {
      const r = await vm.getItems({ categoryId: '*', page })
      ids.push(...r.items.map((i) => i.id))
      totalPages = r.totalPages
      page++
    } while (page <= totalPages)

    expect(totalPages).toBe(3) // 8 portal pages in batches of 3
    expect(ids).toHaveLength(TOTAL)
    expect(new Set(ids).size).toBe(TOTAL)
    // Every portal page fetched exactly once.
    expect(client.requested).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('reports a single page for a category that fits in one batch', async () => {
    const vm = new VodManager({
      _stalkerCall: async () => ({ js: { total_items: '5', max_page_items: '14', data: [{ id: '1' }] } }),
    })
    const r = await vm.getItems({ categoryId: '1', page: 1 })
    expect(r.totalPages).toBe(1)
  })
})
