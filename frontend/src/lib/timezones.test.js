import { describe, it, expect } from 'vitest'
import { allTimezones, utcOffset, zoneWords, filterTimezones } from './timezones'

const ZONES = ['America/New_York', 'America/Argentina/Buenos_Aires', 'Europe/London', 'Europe/Lisbon', 'Asia/Kolkata', 'UTC', 'America/Newfoundland_fake']
const OFFSETS = { 'America/New_York': 'UTC−05:00', 'America/Argentina/Buenos_Aires': 'UTC−03:00', 'Europe/London': 'UTC', 'Europe/Lisbon': 'UTC', 'Asia/Kolkata': 'UTC+05:30', UTC: 'UTC', 'America/Newfoundland_fake': 'UTC−03:30' }
const offsetOf = (z) => OFFSETS[z]

describe('allTimezones', () => {
  it('lists the zones in order, with UTC and the saved one', () => {
    const all = allTimezones('Mars/Olympus_Mons')
    expect(all).toContain('Europe/London')
    expect(all).toContain('UTC')
    expect(all).toContain('Mars/Olympus_Mons')
    expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b)))
  })
})

describe('utcOffset', () => {
  it('names a zone by its offset at a moment', () => {
    const winter = new Date('2026-01-15T12:00:00Z')
    expect(utcOffset('Europe/London', winter)).toBe('UTC')
    expect(utcOffset('Asia/Kolkata', winter)).toBe('UTC+05:30')
    expect(utcOffset('America/New_York', winter)).toBe('UTC−05:00')
    expect(utcOffset('Not/AZone', winter)).toBe('')
  })
})

describe('zoneWords', () => {
  it('reads a zone city first', () => {
    expect(zoneWords('America/Argentina/Buenos_Aires')).toBe('Buenos Aires, Argentina, America')
  })
})

describe('filterTimezones', () => {
  it('matches by any part of the name, spaces for underscores, city matches first', () => {
    expect(filterTimezones(ZONES, 'new york', offsetOf)).toEqual(['America/New_York'])
    expect(filterTimezones(ZONES, 'buenos', offsetOf)).toEqual(['America/Argentina/Buenos_Aires'])
    expect(filterTimezones(ZONES, 'new', offsetOf)[0]).toBe('America/New_York')
    expect(filterTimezones(ZONES, 'europe', offsetOf)).toEqual(['Europe/Lisbon', 'Europe/London'])
  })

  it('matches by UTC offset', () => {
    expect(filterTimezones(ZONES, '+05:30', offsetOf)).toEqual(['Asia/Kolkata'])
    expect(filterTimezones(ZONES, 'utc-05', offsetOf)).toEqual(['America/New_York'])
  })

  it('keeps everything for an empty search, nothing for no match', () => {
    expect(filterTimezones(ZONES, '  ', offsetOf)).toBe(ZONES)
    expect(filterTimezones(ZONES, 'atlantis', offsetOf)).toEqual([])
  })
})
