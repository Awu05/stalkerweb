import { describe, it, expect } from 'vitest'
import { skipAt, autoSkipTo, matchLabel } from './skipSegments'

const parts = { intro: { start: 60, end: 90 }, recap: { start: 0, end: 40 }, outro: { start: 2800, end: 2900 } }

describe('skipAt', () => {
  it('names the part playing and where a skip lands', () => {
    expect(skipAt(parts, 10)).toEqual({ kind: 'recap', label: 'Skip recap', to: 40 })
    expect(skipAt(parts, 60)).toEqual({ kind: 'intro', label: 'Skip intro', to: 90 })
    expect(skipAt(parts, 2850)).toEqual({ kind: 'outro', label: 'Skip credits', to: 2900 })
  })

  it('is nothing between parts, in a part\'s last second, or without times', () => {
    expect(skipAt(parts, 50)).toBe(null)
    expect(skipAt(parts, 89.5)).toBe(null)
    expect(skipAt(null, 10)).toBe(null)
    expect(skipAt({ intro: null, recap: null, outro: null }, 10)).toBe(null)
  })
})

describe('autoSkipTo', () => {
  it('skips an intro or recap once, never the credits', () => {
    const done = new Set()
    expect(autoSkipTo(parts, 61, done)).toBe(90)
    done.add('intro')
    expect(autoSkipTo(parts, 61, done)).toBe(null)
    expect(autoSkipTo(parts, 2850, done)).toBe(null)
  })
})

describe('matchLabel', () => {
  it('names the IMDb title the show was matched to', () => {
    expect(matchLabel({ title: 'Breaking Bad', year: '2008' })).toBe('Breaking Bad (2008)')
    expect(matchLabel({ title: 'Shogun', year: '' })).toBe('Shogun')
    expect(matchLabel(null)).toBe('')
  })
})
