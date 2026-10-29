import { describe, it, expect } from 'vitest'
import { skipAt, autoSkipTo, matchLabel, skipModeOf, nextPromptAt, NEXT_PROMPT_SECS } from './skipSegments'

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

  it('is nothing with intro skipping off', () => {
    expect(skipAt({ ...parts, skipMode: 'off' }, 10)).toBe(null)
    expect(skipAt({ ...parts, skipMode: 'off' }, 2850)).toBe(null)
  })
})

describe('skipModeOf', () => {
  it("is the viewer's mode, an older server's autoSkip, or the Skip button", () => {
    expect(skipModeOf({ skipMode: 'off', autoSkip: false })).toBe('off')
    expect(skipModeOf({ autoSkip: true })).toBe('auto')
    expect(skipModeOf({ skipMode: 'nonsense' })).toBe('button')
    expect(skipModeOf(null)).toBe('button')
  })
})

describe('autoSkipTo', () => {
  const auto = { ...parts, skipMode: 'auto' }
  it('skips an intro or recap once, never the credits', () => {
    const done = new Set()
    expect(autoSkipTo(auto, 61, done)).toBe(90)
    done.add('intro')
    expect(autoSkipTo(auto, 61, done)).toBe(null)
    expect(autoSkipTo(auto, 2850, done)).toBe(null)
  })

  it('skips nothing unless the viewer chose to skip automatically', () => {
    expect(autoSkipTo({ ...parts, skipMode: 'button' }, 61, new Set())).toBe(null)
    expect(autoSkipTo({ ...parts, skipMode: 'off' }, 61, new Set())).toBe(null)
    expect(autoSkipTo({ ...parts, autoSkip: true }, 61, new Set())).toBe(90)
  })
})

describe('nextPromptAt', () => {
  const dur = 2950
  it('shows in the last 30 seconds when there is a next episode, without any skip times', () => {
    expect(NEXT_PROMPT_SECS).toBe(30)
    expect(nextPromptAt(null, dur - 30, dur, true)).toBe(true)
    expect(nextPromptAt(null, dur - 5, dur, true)).toBe(true)
    expect(nextPromptAt(null, dur - 31, dur, true)).toBe(false)
  })

  it('shows during the credits, as the Skip credits button did', () => {
    expect(nextPromptAt(parts, 2850, dur, true)).toBe(true)
    expect(nextPromptAt(parts, 2700, dur, true)).toBe(false)
  })

  it('shows near the end even with intro skipping off, but not in the credits then', () => {
    const off = { ...parts, skipMode: 'off' }
    expect(nextPromptAt(off, dur - 10, dur, true)).toBe(true)
    expect(nextPromptAt(off, 2850, dur, true)).toBe(false)
  })

  it('is nothing without a next episode, or before the duration is known', () => {
    expect(nextPromptAt(parts, 2850, dur, false)).toBe(false)
    expect(nextPromptAt(null, dur - 5, dur, false)).toBe(false)
    expect(nextPromptAt(null, 5, 0, true)).toBe(false)
    expect(nextPromptAt(null, 5, NaN, true)).toBe(false)
    expect(nextPromptAt(null, NaN, dur, true)).toBe(false)
  })
})

describe('matchLabel', () => {
  it('names the IMDb title the show was matched to', () => {
    expect(matchLabel({ title: 'Breaking Bad', year: '2008' })).toBe('Breaking Bad (2008)')
    expect(matchLabel({ title: 'Shogun', year: '' })).toBe('Shogun')
    expect(matchLabel(null)).toBe('')
  })
})
