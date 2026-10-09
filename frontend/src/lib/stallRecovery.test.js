import { describe, it, expect } from 'vitest'
import { jumpTarget, resumePosition, rangesOf } from './stallRecovery'

describe('jumpTarget', () => {
  it('jumps over a hole to the video loaded just ahead', () => {
    // Frozen at the end of the first range, more video from 30.4s.
    expect(jumpTarget([[0, 30], [30.4, 60]], 29.98)).toBeCloseTo(30.5)
  })

  it('jumps when the playhead sits in a hole', () => {
    expect(jumpTarget([[0, 30], [31, 60]], 30.5)).toBeCloseTo(31.1)
  })

  it('nudges a decoder stall with plenty loaded ahead', () => {
    expect(jumpTarget([[0, 60]], 20)).toBeCloseTo(20.2)
  })

  it('waits when nothing is loaded ahead', () => {
    expect(jumpTarget([[0, 30]], 29.9)).toBe(null)
    expect(jumpTarget([], 5)).toBe(null)
  })

  it('does not leap a long way ahead', () => {
    expect(jumpTarget([[0, 30], [55, 80]], 29.9)).toBe(null)
  })
})

describe('resumePosition', () => {
  const frags = [
    { sn: 100, start: 0, duration: 6 },
    { sn: 101, start: 6, duration: 6 },
    { sn: 102, start: 12, duration: 6 },
  ]

  it('rejoins at the same spot in the segment that was playing', () => {
    expect(resumePosition(frags, { sn: 101, offset: 2.5 })).toBe(8.5)
  })

  it('stays inside the segment', () => {
    expect(resumePosition(frags, { sn: 101, offset: 9 })).toBe(11.5)
    expect(resumePosition(frags, { sn: 101, offset: -3 })).toBe(6)
  })

  it('gives up when the segment is gone or nothing was playing', () => {
    expect(resumePosition(frags, { sn: 99, offset: 1 })).toBe(null)
    expect(resumePosition(frags, null)).toBe(null)
  })
})

describe('rangesOf', () => {
  it('turns TimeRanges into pairs', () => {
    const tr = { length: 2, start: i => [0, 31][i], end: i => [30, 60][i] }
    expect(rangesOf(tr)).toEqual([[0, 30], [31, 60]])
    expect(rangesOf(null)).toEqual([])
  })
})
