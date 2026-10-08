import { describe, it, expect } from 'vitest'
import { standardCategories } from '../lib/guideCategories.js'

describe('standardCategories', () => {
  it('maps common portal genres', () => {
    expect(standardCategories('ENGLISH | KIDS')).toEqual(['Kids'])
    expect(standardCategories('USA SPORTS')).toEqual(['Sports'])
    expect(standardCategories('UK | NEWS')).toEqual(['News'])
    expect(standardCategories('ENGLISH | MOVIES')).toEqual(['Movie'])
    expect(standardCategories('Cinema')).toEqual(['Movie'])
  })

  it('splits letters from digits and ignores accents', () => {
    expect(standardCategories('NEWS24')).toEqual(['News'])
    expect(standardCategories('News18 India')).toEqual(['News'])
    expect(standardCategories('Film4')).toEqual(['Movie'])
    expect(standardCategories('FR | Cinéma')).toEqual(['Movie'])
    expect(standardCategories('ES | Películas')).toEqual(['Movie'])
    expect(standardCategories('DE | Nachrichten')).toEqual(['News'])
  })

  it('matches whole words only', () => {
    expect(standardCategories('Transport TV')).toEqual([])
    expect(standardCategories('Passport Travel')).toEqual([])
    expect(standardCategories('Embracing Life')).toEqual([])
    expect(standardCategories('Childish Gambino Live')).toEqual([])
    expect(standardCategories('Newsome Lifestyle')).toEqual([])
    expect(standardCategories('Nickel Classics')).toEqual([])
  })

  it('returns nothing for genres it cannot place', () => {
    expect(standardCategories('ENGLISH | USA')).toEqual([])
    expect(standardCategories('Documentary')).toEqual([])
    expect(standardCategories('')).toEqual([])
    expect(standardCategories(null)).toEqual([])
  })

  it('can return more than one, in a fixed order', () => {
    expect(standardCategories('Kids Movies')).toEqual(['Kids', 'Movie'])
  })
})
