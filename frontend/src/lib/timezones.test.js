import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZONES } from './timezones.generated'
import { zoneEntries, filterZones, parseOffset, offsetLabel, offsetMinutes, isZone, utcOffset } from './timezones'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WINTER = new Date('2026-01-15T12:00:00Z')
const ids = (list) => list.map((z) => z.id)

describe('the list', () => {
  it('is the shared one, up to date (run `node shared/build-timezones.mjs` after changing it)', () => {
    expect(() => execFileSync(globalThis.process.execPath, [path.join(repo, 'shared', 'build-timezones.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow()
  })

  it('has the zones by their current names, not the old ones', () => {
    const names = ZONES.map(([id]) => id)
    for (const z of ['UTC', 'Asia/Kolkata', 'Europe/Kyiv', 'Asia/Ho_Chi_Minh', 'America/Argentina/Buenos_Aires', 'America/New_York']) expect(names).toContain(z)
    for (const z of ['Asia/Calcutta', 'Europe/Kiev', 'US/Eastern']) expect(names).not.toContain(z)
  })
})

describe('offsets', () => {
  it('reads a zone by its offset at a moment', () => {
    expect(offsetMinutes('Asia/Kolkata', WINTER)).toBe(330)
    expect(offsetMinutes('America/New_York', WINTER)).toBe(-300)
    expect(offsetMinutes('Europe/London', WINTER)).toBe(0)
    expect(offsetMinutes('Not/AZone', WINTER)).toBe(null)
    expect(utcOffset('Asia/Kolkata', WINTER)).toBe('UTC+05:30')
    expect(offsetLabel(-300)).toBe('UTC−05:00')
    expect(offsetLabel(0)).toBe('UTC')
  })

  it('reads a search that is an offset, the ways people type it', () => {
    expect(parseOffset('UTC+1')).toBe(60)
    expect(parseOffset('+1')).toBe(60)
    expect(parseOffset('-5')).toBe(-300)
    expect(parseOffset('utc-5')).toBe(-300)
    expect(parseOffset('gmt+5:30')).toBe(330)
    expect(parseOffset('+0530')).toBe(330)
    expect(parseOffset('UTC − 05:00')).toBe(-300)
    expect(parseOffset('gmt')).toBe(0)
    expect(parseOffset('london')).toBe(null)
    expect(parseOffset('+25')).toBe(null)
  })
})

describe('filterZones', () => {
  const entries = zoneEntries('', WINTER)

  it('finds a zone by any part of its name, or its country, city matches first', () => {
    expect(ids(filterZones(entries, 'new york'))).toEqual(['America/New_York'])
    expect(ids(filterZones(entries, 'kolkata'))).toEqual(['Asia/Kolkata'])
    expect(ids(filterZones(entries, 'india'))[0]).toBe('Asia/Kolkata')
    expect(ids(filterZones(entries, 'buenos'))[0]).toBe('America/Argentina/Buenos_Aires')
    expect(ids(filterZones(entries, 'london'))[0]).toBe('Europe/London')
  })

  it('finds the zones at an offset', () => {
    const plusOne = ids(filterZones(entries, 'UTC+1'))
    expect(plusOne).toContain('Europe/Paris')
    expect(plusOne).toContain('Africa/Lagos')
    expect(plusOne).not.toContain('Australia/Sydney')
    expect(ids(filterZones(entries, '-5'))).toContain('America/New_York')
    expect(ids(filterZones(entries, '+5:30'))).toEqual(['Asia/Colombo', 'Asia/Kolkata'])
  })

  it('keeps everything for an empty search, nothing for no match', () => {
    expect(filterZones(entries, '  ')).toBe(entries)
    expect(filterZones(entries, 'atlantis')).toEqual([])
  })

  it('keeps a saved zone that is not in the list, and knows a real one from a typo', () => {
    expect(ids(zoneEntries('Etc/GMT-3', WINTER))[0]).toBe('Etc/GMT-3')
    expect(isZone('Etc/GMT-3')).toBe(true)
    expect(isZone('Asia/Calcutta')).toBe(true)
    expect(isZone('Europe/Londno')).toBe(false)
  })
})
