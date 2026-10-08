import { describe, it, expect, vi } from 'vitest'
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

  it('getAllItems reads every page once and shares the cached result', async () => {
    const client = fakeClient()
    const vm = new VodManager(client, { pageGapMs: 0 })

    const [a, b] = await Promise.all([vm.getAllItems('vod', '7'), vm.getAllItems('vod', '7')])
    expect(a).toHaveLength(TOTAL)
    expect(b).toBe(a)
    expect(a[0].categoryId).toBe('7')
    expect(client.requested).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    await vm.getAllItems('vod', '7')
    expect(client.requested).toHaveLength(8) // cached
  })

  it('getAllItems keeps the pages read before a later page fails', async () => {
    const client = fakeClient()
    const ok = client._stalkerCall
    client._stalkerCall = async (params) => {
      if (params.p === '3') throw new Error('HTTP 429')
      return ok(params)
    }
    const items = await new VodManager(client, { pageGapMs: 0 }).getAllItems('vod', '1')
    expect(items).toHaveLength(2 * PER_PAGE)
  })

  it('getAllItems keeps a partial listing for minutes, not the full hour', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      const ok = client._stalkerCall
      let failPage3 = true
      client._stalkerCall = async (params) => {
        if (failPage3 && params.p === '3') throw new Error('HTTP 429')
        return ok(params)
      }
      const vm = new VodManager(client, { pageGapMs: 0 })

      expect(await vm.getAllItems('vod', '1')).toHaveLength(2 * PER_PAGE)
      expect(vm.peekAllItems('vod', '1')).toHaveLength(2 * PER_PAGE)

      failPage3 = false
      vi.advanceTimersByTime(3 * 60 * 1000)
      expect(vm.peekAllItems('vod', '1')).toBeUndefined()
      expect(await vm.getAllItems('vod', '1')).toHaveLength(TOTAL)
    } finally {
      vi.useRealTimers()
    }
  })

  it('getRange reads only the pages covering the range', async () => {
    const client = fakeClient()
    const vm = new VodManager(client, { pageGapMs: 0 })

    const { items, total } = await vm.getRange('vod', '1', 20, 30)   // titles 21–50
    expect(total).toBe(TOTAL)
    expect(items.map((i) => i.id)).toEqual(Array.from({ length: 30 }, (_, i) => String(21 + i)))
    expect(client.requested).toEqual([1, 2, 3, 4])                    // page 1 for the totals, then 2–4

    expect((await vm.getRange('vod', '1', 90, 100)).items).toHaveLength(10)  // past the end
    expect((await vm.getRange('vod', '1', 200, 100)).items).toEqual([])
  })

  it('getAllItems reuses the pages getRange already read', async () => {
    const client = fakeClient()
    const vm = new VodManager(client, { pageGapMs: 0 })
    await vm.getRange('vod', '1', 0, 30)
    await vm.getAllItems('vod', '1')
    expect(client.requested).toEqual([1, 2, 3, 4, 5, 6, 7, 8])        // each page once
  })

  it('reports a single page for a category that fits in one batch', async () => {
    const vm = new VodManager({
      _stalkerCall: async () => ({ js: { total_items: '5', max_page_items: '14', data: [{ id: '1' }] } }),
    })
    const r = await vm.getItems({ categoryId: '1', page: 1 })
    expect(r.totalPages).toBe(1)
  })
})
