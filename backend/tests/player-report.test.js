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
      .toContain('the player gave up')
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

describe('isDecodeFailure', () => {
  it("knows a device that couldn't decode from one that lost the stream", async () => {
    const { isDecodeFailure } = await import('../lib/playerReport.js')
    expect(isDecodeFailure({ kind: 'video error', detail: 'MediaError 3 (decode): Media failed to decode' })).toBe(true)
    expect(isDecodeFailure({ kind: 'mediaError', detail: 'bufferAppendError: The object is in an invalid state.' })).toBe(true)
    expect(isDecodeFailure({ kind: 'video error', detail: 'MediaError 4 (format not supported)' })).toBe(true)
    expect(isDecodeFailure({ kind: 'ended', detail: 'the stream ended — reconnecting' })).toBe(false)
    expect(isDecodeFailure({ kind: 'networkError', detail: 'fragLoadError: HTTP 502' })).toBe(false)
  })
})

describe('describeStreams', () => {
  it('puts what decides whether a device can play it in one line', async () => {
    const { describeStreams } = await import('../stalker/FfmpegService.js')
    const v = { codec_name: 'hevc', profile: 'Main 10', codec_tag_string: '[36][0][0][0]', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', field_order: 'progressive', avg_frame_rate: '50/1' }
    const a = { codec_name: 'aac', channels: 2, sample_rate: '48000' }
    expect(describeStreams(v, a, 'hls')).toBe('video hevc Main 10 3840x2160 yuv420p10le progressive 50fps, audio aac 2ch 48000Hz, in hls')
    expect(describeStreams({ ...v, codec_tag_string: 'hev1' }, null, 'mp4')).toBe('video hevc Main 10 (hev1) 3840x2160 yuv420p10le progressive 50fps, no audio, in mp4')
    expect(describeStreams(null, null, null)).toBe('no video, no audio, in ?')
  })
})

describe('browserDirectPlayable', () => {
  it('copies what browsers play (H.264, HEVC, AAC, MP3) and converts the rest', async () => {
    const { browserDirectPlayable } = await import('../stalker/FfmpegService.js')
    expect(browserDirectPlayable({ video: 'h264', audio: 'aac' })).toBe(true)
    expect(browserDirectPlayable({ video: 'hevc', audio: 'mp3' })).toBe(true)
    expect(browserDirectPlayable({ video: 'mpeg2video', audio: 'aac' })).toBe(false)
    expect(browserDirectPlayable({ video: 'h264', audio: 'ac3' })).toBe(false)
  })
})
