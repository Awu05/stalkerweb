import { describe, it, expect } from 'vitest'
import { skipAt, autoSkipTo, matchLabel, skipModeOf, nextPromptAt, inCredits, beforeCredits, creditsReached, nextEpisodeDelayOf, NEXT_PROMPT_SECS } from './skipSegments'

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

describe('inCredits', () => {
  it('during the credits only', () => {
    expect(inCredits(parts, 2850)).toBe(true)
    expect(inCredits(parts, 2790)).toBe(false)
  })
  it('not without credits times, nor with skipping off', () => {
    expect(inCredits({ intro: null, recap: null, outro: null }, 2990)).toBe(false)
    expect(inCredits(null, 2990)).toBe(false)
    expect(inCredits({ ...parts, skipMode: 'off' }, 2850)).toBe(false)
  })
})

describe('beforeCredits', () => {
  it('past the first seconds and before the credits', () => {
    expect(beforeCredits(parts, 600)).toBe(true)
    expect(beforeCredits(parts, 2799)).toBe(true)
  })
  it('not in the credits, not in the first seconds a resume passes through, not without credits times', () => {
    expect(beforeCredits(parts, 2850)).toBe(false)
    expect(beforeCredits(parts, 0)).toBe(false)
    expect(beforeCredits(parts, 2)).toBe(false)
    expect(beforeCredits({ intro: null, recap: null, outro: null }, 600)).toBe(false)
  })
})

describe('creditsReached', () => {
  const outro = { start: 2800, end: 2900 }
  it('from the start of the credits on', () => {
    expect(creditsReached(outro, 2800, 2950)).toBe(true)
    expect(creditsReached(outro, 2940, 2950)).toBe(true)
    expect(creditsReached(outro, 2799, 2950)).toBe(false)
  })
  it('whatever the intro skipping: the credits times are what count', () => {
    expect(creditsReached({ start: 2800, end: 2900 }, 2850, 2950)).toBe(true)
  })
  it('not without credits times, a duration or a position', () => {
    expect(creditsReached(null, 2850, 2950)).toBe(false)
    expect(creditsReached(outro, 2850, 0)).toBe(false)
    expect(creditsReached(outro, NaN, 2950)).toBe(false)
  })
  it('not for "credits" starting before the last fifth (a wrong match)', () => {
    expect(creditsReached({ start: 1000, end: 1100 }, 1050, 2950)).toBe(false)
  })
})

describe('nextEpisodeDelayOf', () => {
  it("is the viewer's choice, or 5 s from an older server or an odd value", () => {
    expect(nextEpisodeDelayOf({ nextEpisodeDelay: 0 })).toBe(0)
    expect(nextEpisodeDelayOf({ nextEpisodeDelay: -1 })).toBe(-1)
    expect(nextEpisodeDelayOf({ nextEpisodeDelay: 15 })).toBe(15)
    expect(nextEpisodeDelayOf({})).toBe(5)
    expect(nextEpisodeDelayOf({ nextEpisodeDelay: 7 })).toBe(5)
    expect(nextEpisodeDelayOf(null)).toBe(5)
  })
})
