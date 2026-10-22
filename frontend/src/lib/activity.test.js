import { describe, it, expect } from 'vitest'
import { playingFor, kindLabel, viaLabel, portalSummary } from './activity'

describe('Settings → Activity words', () => {
  it('says how long something has played', () => {
    expect(playingFor(0, 30_000)).toBe('just now')
    expect(playingFor(0, 12 * 60_000)).toBe('12 min')
    expect(playingFor(0, 65 * 60_000)).toBe('1 h 5 min')
    expect(playingFor(0, 120 * 60_000)).toBe('2 h')
  })

  it('badges live, a movie, an episode and a cast', () => {
    expect(kindLabel({ kind: 'live', id: '5', via: 'app' })).toBe('Live')
    expect(kindLabel({ kind: 'vod', id: '100', via: 'app' })).toBe('Movie')
    expect(kindLabel({ kind: 'vod', id: '200:s1:e3', via: 'app' })).toBe('Episode')
    expect(kindLabel({ kind: 'live', id: '5', via: 'cast' })).toBe('Cast')
  })

  it('says how it got here', () => {
    expect(viaLabel({ via: 'xtream' })).toBe('Xtream player')
    expect(viaLabel({ via: 'app' })).toBe('')
  })

  it('sums up the portal', () => {
    expect(portalSummary({ connected: true, host: 'portal.example', openStreams: 2, casting: 1 })).toBe('portal.example · 2 open streams · 1 channel cast to a TV')
    expect(portalSummary({ connected: true, host: 'p', openStreams: 1, casting: 0 })).toBe('p · 1 open stream')
    expect(portalSummary({ connected: false })).toBe('Portal not connected')
  })
})
