import { describe, it, expect } from 'vitest'
import { codecLabel, formatBitrate, bufferAhead, deliveryText, sampleEngine, trackHlsStats } from './streamStats'

const ranges = (...r) => ({ length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] })

describe('codecLabel', () => {
  it('names the codecs players report', () => {
    expect(codecLabel('avc1.64001f')).toBe('H.264')
    expect(codecLabel('hvc1.2.4.L153.B0')).toBe('H.265')
    expect(codecLabel('hev1.1.6.L93.90')).toBe('H.265')
    expect(codecLabel('mp4a.40.2')).toBe('AAC')
    expect(codecLabel('mp4a.40.34')).toBe('MP3')
    expect(codecLabel('ac-3')).toBe('AC-3')
    expect(codecLabel('ec-3')).toBe('E-AC-3')
    expect(codecLabel('av01.0.08M.08')).toBe('AV1')
  })

  it('passes through what it does not know, and is empty for nothing', () => {
    expect(codecLabel('flac')).toBe('flac')
    expect(codecLabel('')).toBe('')
    expect(codecLabel(undefined)).toBe('')
  })
})

describe('formatBitrate', () => {
  it('uses kb/s below a megabit, Mb/s above', () => {
    expect(formatBitrate(640_000)).toBe('640 kb/s')
    expect(formatBitrate(4_250_000)).toBe('4.3 Mb/s')
    expect(formatBitrate(0)).toBe('—')
    expect(formatBitrate(null)).toBe('—')
    expect(formatBitrate(NaN)).toBe('—')
  })
})

describe('bufferAhead', () => {
  it('measures from the playhead to the end of its buffered range', () => {
    expect(bufferAhead(ranges([0, 10], [20, 30]), 4)).toBe(6)
    expect(bufferAhead(ranges([0, 10], [20, 30]), 25)).toBe(5)
    expect(bufferAhead(ranges([0, 10]), 12)).toBe(0)
    expect(bufferAhead(null, 3)).toBe(0)
  })
})

describe('deliveryText', () => {
  it('says how the server sends the stream', () => {
    expect(deliveryText({ mode: 'direct', detail: '' })).toBe('Straight from the provider')
    expect(deliveryText({ mode: 'relayed', detail: 'HLS' })).toBe('Relayed by the server (HLS)')
    expect(deliveryText({ mode: 'repackaged', detail: '' })).toBe('Repackaged by the server (no quality loss)')
    expect(deliveryText({ mode: 'converted', detail: 'audio → AAC' })).toBe('Converted by the server (audio → AAC)')
    expect(deliveryText(null)).toBe('—')
  })
})

describe('sampleEngine', () => {
  it("reads hls.js's playing level and its speed estimate", () => {
    const hls = { currentLevel: 1, levels: [{}, { width: 1920, height: 1080, bitrate: 6_000_000, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2' }], bandwidthEstimate: 25_000_000 }
    expect(sampleEngine({ hls })).toEqual({ video: 'H.264', audio: 'AAC', bitrate: 6_000_000, download: 25_000_000 })
  })

  it('falls back to what hls.js found playing, when the playlist named no codecs or bitrate', () => {
    const handlers = {}
    const hls = { currentLevel: 0, levels: [{ bitrate: 0 }], bandwidthEstimate: 0, on: (e, f) => { handlers[e] = f } }
    trackHlsStats(hls, { BUFFER_CODECS: 'codecs', FRAG_LOADED: 'frag' })
    handlers.codecs('codecs', { video: { codec: 'hvc1.2.4.L153' }, audio: { codec: 'mp4a.40.2' } })
    handlers.frag('frag', { frag: { type: 'main', duration: 4, stats: { loaded: 2_000_000 } } })
    expect(sampleEngine({ hls })).toEqual({ video: 'H.265', audio: 'AAC', bitrate: 4_000_000, download: null })
  })

  it("reads mpegts.js's media info and its download speed (KB/s)", () => {
    const mpegts = { mediaInfo: { videoCodec: 'avc1.4d401f', audioCodec: 'mp4a.40.2', videoDataRate: 3000, audioDataRate: 128 }, statisticsInfo: { speed: 500 } }
    expect(sampleEngine({ mpegts })).toEqual({ video: 'H.264', audio: 'AAC', bitrate: 3_128_000, download: 4_096_000 })
  })

  it('knows nothing more about the browser\'s own player', () => {
    expect(sampleEngine({})).toEqual({ video: '', audio: '', bitrate: null, download: null })
  })
})
