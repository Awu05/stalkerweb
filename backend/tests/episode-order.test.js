import { describe, it, expect } from 'vitest'
import VodManager from '../stalker/VodManager.js'

// A portal that lists seasons and episodes newest first, as many do.
const portal = (data) => ({ _stalkerCall: async () => ({ js: { data } }) })

describe('season and episode order', () => {
  it('lists seasons from the first, by number', async () => {
    const vm = new VodManager(portal([
      { id: 's10', season_number: 10, name: 'Season 10' },
      { id: 's2', season_number: 2, name: 'Season 2' },
      { id: 's1', season_number: 1, name: 'Season 1' },
    ]))
    expect((await vm.getSeasons('show')).map((s) => s.id)).toEqual(['s1', 's2', 's10'])
  })

  it('lists episodes from the first, by number, then by name when there is none', async () => {
    const vm = new VodManager(portal([
      { id: 'e14', series_number: 14 },
      { id: 'e2', series_number: 2 },
      { id: 'x', name: 'Episode 11' },
      { id: 'e1', series_number: 1 },
      { id: 'y', name: 'Episode 3' },
    ]))
    expect((await vm.getEpisodes('show', 's1')).map((e) => e.episodeId)).toEqual(['e1', 'e2', 'e14', 'y', 'x'])
  })

  it('reads every page of a season, not just the first 14', async () => {
    // 24 episodes, 14 a page, newest first: page 1 is episodes 24…11, page 2 is 10…1.
    const all = Array.from({ length: 24 }, (_, i) => ({ id: 'e' + (i + 1), series_number: i + 1 })).reverse()
    const asked = []
    const vm = new VodManager({
      _stalkerCall: async (q) => {
        asked.push(q.p)
        const p = parseInt(q.p, 10)
        return { js: { total_items: 24, max_page_items: 14, data: all.slice((p - 1) * 14, p * 14) } }
      },
    })
    const eps = await vm.getEpisodes('show', 's1')
    expect(eps.map((e) => e.seriesNumber)).toEqual(Array.from({ length: 24 }, (_, i) => String(i + 1)))
    expect(asked).toEqual(['1', '2'])
  })

  it('lists an episode once when pages overlap, and stops at an empty page', async () => {
    const pages = { 1: [{ id: 'e3', series_number: 3 }, { id: 'e2', series_number: 2 }], 2: [{ id: 'e2', series_number: 2 }, { id: 'e1', series_number: 1 }], 3: [] }
    const vm = new VodManager({ _stalkerCall: async (q) => ({ js: { total_items: 99, max_page_items: 2, data: pages[q.p] ?? [] } }) })
    expect((await vm.getEpisodes('show', 's1')).map((e) => e.episodeId)).toEqual(['e1', 'e2', 'e3'])
  })

  it("reads every page of a show's seasons too (a show with more than 14)", async () => {
    const all = Array.from({ length: 20 }, (_, i) => ({ id: 's' + (i + 1), season_number: i + 1 })).reverse()
    const vm = new VodManager({
      _stalkerCall: async (q) => {
        const p = parseInt(q.p, 10)
        return { js: { total_items: 20, max_page_items: 14, data: all.slice((p - 1) * 14, p * 14) } }
      },
    })
    expect((await vm.getSeasons('show')).map((s) => s.seasonNumber)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)))
  })
})
