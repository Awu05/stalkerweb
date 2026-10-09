import { describe, it, expect } from 'vitest'
import { NO_FILTERS, filtersActive, applyVodFilters, sortVodItems, filterOptions, decadeOf } from './vodFilters'

const now = Date.parse('2026-10-09T12:00:00')
const t = (id, extra) => ({ id, name: `Title ${id}`, year: '', genres: [], rating: 0, isHD: false, added: '', ...extra })
const items = [
  t('1', { name: 'Zodiac', year: '2007', genres: ['Crime', 'Drama'], rating: 7.7, isHD: true, added: '2026-10-05 10:00:00' }),
  t('2', { name: 'Arrival', year: '2016', genres: ['Drama', 'Sci-Fi'], rating: 7.9, added: '2026-08-01 10:00:00' }),
  t('3', { name: 'Alien', year: '1979', genres: ['Horror'], rating: 8.5, isHD: true, added: '2026-10-08 10:00:00' }),
  t('4', { name: 'Title 10', year: '' }),
  t('5', { name: 'Title 9', year: '2021' }),
]
const ids = (list) => list.map((x) => x.id)

describe('applyVodFilters', () => {
  it('keeps everything with no filters', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false)
    expect(ids(applyVodFilters(items, NO_FILTERS, { now }))).toEqual(['1', '2', '3', '4', '5'])
  })

  it('filters by genre, decade, rating, recently added and HD — together', () => {
    const f = (x) => ids(applyVodFilters(items, { ...NO_FILTERS, ...x }, { now }))
    expect(f({ genre: 'Drama' })).toEqual(['1', '2'])
    expect(f({ year: '2000s' })).toEqual(['1'])
    expect(f({ year: 'Older' })).toEqual(['3'])
    expect(f({ year: '2016' })).toEqual(['2'])
    expect(f({ minRating: 7.8 })).toEqual(['2', '3'])
    expect(f({ addedDays: 7 })).toEqual(['1', '3'])
    expect(f({ hd: true })).toEqual(['1', '3'])
    expect(f({ genre: 'Drama', hd: true })).toEqual(['1'])
  })

  it('leaves out titles already started or watched, and matches the search', () => {
    expect(ids(applyVodFilters(items, { ...NO_FILTERS, unwatched: true }, { now, watched: new Set(['1', '3']) }))).toEqual(['2', '4', '5'])
    expect(ids(applyVodFilters(items, NO_FILTERS, { now, search: 'ali' }))).toEqual(['3'])
  })
})

describe('sortVodItems', () => {
  it('sorts A–Z with numbers in order, or newest first', () => {
    expect(ids(sortVodItems(items, 'name'))).toEqual(['3', '2', '5', '4', '1'])
    expect(ids(sortVodItems(items, 'added')).slice(0, 3)).toEqual(['3', '1', '2'])
  })
})

describe('filterOptions', () => {
  it('offers what the titles have', () => {
    expect(filterOptions(items)).toEqual({
      genres: ['Crime', 'Drama', 'Horror', 'Sci-Fi'],
      years: ['2021', '2016', '2007', '1979'],   // few years: each one
      hasRating: true,
      hasHD: true,
    })
  })

  it('offers no genre or rating when the portal sends none', () => {
    expect(filterOptions([t('1', { year: '2020' })])).toMatchObject({ genres: [], hasRating: false, hasHD: false })
  })
})

describe('decadeOf', () => {
  it('groups years by decade, everything before 1980 as Older', () => {
    expect(decadeOf('2026')).toBe('2020s')
    expect(decadeOf('1985')).toBe('1980s')
    expect(decadeOf('1979')).toBe('Older')
    expect(decadeOf('')).toBe(null)
  })
})

describe('year choices', () => {
  const years = (...ys) => ys.map((y, i) => t(String(i), { year: String(y) }))

  it('lists each year when there are only a few — a category of new releases', () => {
    expect(filterOptions(years(2026, 2025, 2026, 2024)).years).toEqual(['2026', '2025', '2024'])
  })

  it('lists decades when the years are many', () => {
    const many = years(...Array.from({ length: 30 }, (_, i) => 1990 + i))
    expect(filterOptions(many).years).toEqual(['2010s', '2000s', '1990s'])
  })

  it('filters by a single year, or by a decade', () => {
    const list = years(2026, 2025, 2016)
    expect(ids(applyVodFilters(list, { ...NO_FILTERS, year: '2025' }, { now }))).toEqual(['1'])
    expect(ids(applyVodFilters(list, { ...NO_FILTERS, year: '2020s' }, { now }))).toEqual(['0', '1'])
    expect(ids(applyVodFilters(list, { ...NO_FILTERS, year: 'Older' }, { now }))).toEqual([])
  })
})
