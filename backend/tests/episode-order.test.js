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
})
