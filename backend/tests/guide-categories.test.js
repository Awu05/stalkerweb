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

  it('falls back to well-known channel names', () => {
    expect(standardCategories('USA', null, 'ESPN 2')).toEqual(['Sports'])
    expect(standardCategories('USA', null, 'Disney Junior')).toEqual(['Kids'])
    expect(standardCategories('USA', null, 'CNN International')).toEqual(['News'])
  })

  it('returns nothing for genres it cannot place', () => {
    expect(standardCategories('ENGLISH | USA')).toEqual([])
    expect(standardCategories('Documentary')).toEqual([])
    expect(standardCategories()).toEqual([])
  })

  it('does not match inside unrelated words', () => {
    expect(standardCategories('Newsome Lifestyle')).toEqual([])  // "news" only as a word
    expect(standardCategories('Nickel Classics')).toEqual([])
  })
})
