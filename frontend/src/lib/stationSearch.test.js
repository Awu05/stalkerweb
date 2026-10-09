import { describe, it, expect } from 'vitest'
import { matchesStation } from './stationSearch'

const hgtv = { name: 'HGTV 4K', number: 397 }
const cnn = { name: 'CNN', number: 39 }

describe('matchesStation', () => {
  it('matches everything when the search is empty', () => {
    expect(matchesStation(hgtv, '')).toBe(true)
    expect(matchesStation(hgtv, '   ')).toBe(true)
  })

  it('matches part of the name, in any case', () => {
    expect(matchesStation(hgtv, 'hgtv')).toBe(true)
    expect(matchesStation(hgtv, ' 4k ')).toBe(true)
    expect(matchesStation(cnn, 'hgtv')).toBe(false)
  })

  it('matches the start of the channel number', () => {
    expect(matchesStation(hgtv, '39')).toBe(true)
    expect(matchesStation(cnn, '39')).toBe(true)
    expect(matchesStation(cnn, '397')).toBe(false)
    expect(matchesStation(hgtv, '97')).toBe(false)
  })

  it('still matches digits in a name', () => {
    expect(matchesStation({ name: 'Channel 4', number: 0 }, '4')).toBe(true)
  })
})
