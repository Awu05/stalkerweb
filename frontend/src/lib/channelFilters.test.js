import { describe, it, expect } from 'vitest'
import { convertLanguages, vodCategoryList, titleKey, groupGenres, releaseLanguages } from './channelFilters'

describe('convertLanguages', () => {
  it('turns each hidden "language" into the categories it matched', () => {
    const r = convertLanguages(
      ['BEIN SPORTS', 'kids movies'],
      ['BEIN SPORTS | DAZN', 'CRICKET | REPLAYS', 'BEIN SPORTS | 2'],
      ['KIDS MOVIES', 'APPLE TV+ ENGLISH MOVIES'],
    )
    expect(r).toEqual({ genres: ['BEIN SPORTS | DAZN', 'BEIN SPORTS | 2'], vodCategories: ['KIDS MOVIES'] })
  })

  it('gives nothing when nothing was hidden', () => {
    expect(convertLanguages([], ['A | B'], ['C'])).toEqual({ genres: [], vodCategories: [] })
  })
})

describe('vodCategoryList', () => {
  it('lists movie and series categories once each, sorted, without the All pseudo-category', () => {
    const movies = [{ id: '*', title: 'All' }, { id: '1', title: 'Kids Movies' }, { id: '2', title: 'Action' }]
    const series = [{ id: '*', title: 'All' }, { id: '9', title: 'ACTION ' }, { id: '8', title: 'Kids TV Shows' }]
    expect(vodCategoryList(movies, series)).toEqual(['Action', 'Kids Movies', 'Kids TV Shows'])
  })
})

describe('titleKey', () => {
  it('compares names without case or stray spaces, like the server', () => {
    expect(titleKey(' Kids Movies ')).toBe('KIDS MOVIES')
  })
})

describe('groupGenres', () => {
  it('groups live categories by the part before the |, with ungrouped ones last', () => {
    const g = groupGenres([{ id: 1, name: 'CRICKET | REPLAYS' }, { id: 2, name: 'LOCAL' }, { id: 3, name: 'BEIN SPORTS | DAZN' }])
    expect(g.map(([k, list]) => [k, list.map((x) => x.id)])).toEqual([['BEIN SPORTS', [3]], ['CRICKET', [1]], ['Other', [2]]])
  })
})

describe('releaseLanguages', () => {
  const genres = ['HINDI | NEWS', 'HINDI | MOVIES', 'CRICKET | REPLAYS']
  const vod = ['HINDI MOVIES', 'HINDI | 2026', 'KIDS MOVIES']

  it('drops the old language and hides the rest of it one by one, so only what was asked for comes back', () => {
    const r = releaseLanguages(['HINDI | NEWS'], new Set(['HINDI']), genres, vod)
    expect(r).toEqual({ languages: [], hideGenres: ['HINDI | MOVIES'], hideVod: ['HINDI | 2026'] })
  })

  it('works from a movie category too, and leaves other old languages alone', () => {
    const r = releaseLanguages(['HINDI | 2026'], new Set(['HINDI', 'BEIN SPORTS']), genres, vod)
    expect(r).toEqual({ languages: ['BEIN SPORTS'], hideGenres: ['HINDI | NEWS', 'HINDI | MOVIES'], hideVod: [] })
  })

  it('does nothing when no old language hides what is shown', () => {
    expect(releaseLanguages(['CRICKET | REPLAYS'], new Set(['HINDI']), genres, vod)).toBe(null)
  })
})
