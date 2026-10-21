import { describe, it, expect } from 'vitest'
import { browserOf, reportLine, rateLimiter } from '../lib/playerReport.js'

const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const WIN_EDGE = WIN_CHROME + ' Edg/140.0.0.0'

describe('browserOf', () => {
  it('names the device and browser, and the iOS version on an iPhone', () => {
    expect(browserOf(IPHONE_CHROME)).toBe('iPhone · Chrome (iOS 18.1)')
    expect(browserOf(IPHONE_SAFARI)).toBe('iPhone · Safari (iOS 17.4)')
    expect(browserOf(WIN_CHROME)).toBe('Windows · Chrome')
    expect(browserOf(WIN_EDGE)).toBe('Windows · Edge')
    expect(browserOf('')).toBe('unknown device · browser')
  })
})

describe('reportLine', () => {
  it('says which channel, which player, what went wrong, and where', () => {
    expect(reportLine({ channelId: '1896', title: 'HGTV 4K', engine: 'hls.js', kind: 'mediaError', detail: 'bufferAppendError: codecs hvc1', attempt: 3 }, IPHONE_CHROME))
      .toBe('ch 1896 "HGTV 4K" on iPhone · Chrome (iOS 18.1): hls.js mediaError — bufferAppendError: codecs hvc1 (reconnect 3)')
    expect(reportLine({ channelId: '1896', engine: 'hls.js', kind: 'gave up', gaveUp: true }, IPHONE_CHROME))
      .toContain('gave up, showed "Lost connection"')
    expect(reportLine({ title: 'Heat', engine: 'native', kind: 'MediaError 4', detail: 'format not supported' }, WIN_CHROME))
      .toBe('"Heat" on Windows · Chrome: native MediaError 4 — format not supported')
  })

  it('keeps what a page sends to one short line', () => {
    const line = reportLine({ channelId: '1', engine: 'hls.js', kind: 'x\nFAKE LOG LINE', detail: 'd'.repeat(5000) }, '')
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(500)
  })

  it('says nothing for a report with nothing in it', () => {
    expect(reportLine({}, '')).toBeNull()
    expect(reportLine(null, '')).toBeNull()
  })
})

describe('rateLimiter', () => {
  it('lets 30 a minute through from one address', () => {
    let t = 0
    const allow = rateLimiter(30, () => t)
    for (let i = 0; i < 30; i++) expect(allow('a')).toBe(true)
    expect(allow('a')).toBe(false)
    expect(allow('b')).toBe(true)
    t += 61_000
    expect(allow('a')).toBe(true)
  })
})
