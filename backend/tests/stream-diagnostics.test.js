import { describe, it, expect, beforeEach } from 'vitest'
import { StreamDiagnostics, firstTimestamps } from '../lib/streamDiagnostics.js'

// One 188-byte TS packet starting a PES packet with the given stream id and PTS (seconds).
function pesPacket(streamId, ptsSeconds) {
  const pkt = Buffer.alloc(188, 0xff)
  pkt[0] = 0x47; pkt[1] = 0x40 | 0x01; pkt[2] = 0x00; pkt[3] = 0x10   // PUSI, payload only
  const pts = Math.round(ptsSeconds * 90000)
  const p = 4
  pkt.set([0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, 0x80, 0x05], p)
  pkt[p + 9]  = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1)
  pkt[p + 10] = (Math.floor(pts / 2 ** 22)) & 0xff
  pkt[p + 11] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1
  pkt[p + 12] = (Math.floor(pts / 2 ** 7)) & 0xff
  pkt[p + 13] = ((pts & 0x7f) << 1) | 1
  return pkt
}
const segmentBytes = (video, audio) => Buffer.concat([pesPacket(0xe0, video), pesPacket(0xc0, audio)])

describe('firstTimestamps', () => {
  it('reads the first video and audio PTS of a TS segment', () => {
    const t = firstTimestamps(segmentBytes(1000.5, 1000.25))
    expect(t.video).toBeCloseTo(1000.5, 3)
    expect(t.audio).toBeCloseTo(1000.25, 3)
  })

  it('returns nulls for data that is not MPEG-TS', () => {
    expect(firstTimestamps(Buffer.from('not a stream'))).toEqual({ video: null, audio: null })
  })
})

describe('StreamDiagnostics', () => {
  let warnings, clock, diag
  const playlist = (seq, n = 3, extra = '') =>
    `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${seq}\n${extra}` +
    Array.from({ length: n }, (_, i) => `#EXTINF:6.0,\nseg${seq + i}.ts?token=t`).join('\n') + '\n'
  const URL0 = 'http://cdn/live/mono.m3u8?token=t'
  const seg = (n) => `http://cdn/live/seg${n}.ts?token=t`
  const fetchSeg = (n, { ms = 1000, bytes = 1e6, data = null } = {}) => {
    const d = diag.segment('7', seg(n))
    d.firstByte()
    if (data) d.data(data)
    clock += ms
    d.done(bytes)
  }

  beforeEach(() => {
    warnings = []
    clock = 0
    diag = new StreamDiagnostics({ logger: { warn: (_t, m) => warnings.push(m), info: () => {} }, now: () => clock })
  })

  it('stays quiet for a healthy stream', () => {
    diag.playlist('7', URL0, playlist(100), 200)
    fetchSeg(100, { data: segmentBytes(10, 10) })
    fetchSeg(101, { data: segmentBytes(16, 16) })
    diag.playlist('7', URL0, playlist(101), 200)
    fetchSeg(102, { data: segmentBytes(22, 22) })
    expect(warnings).toEqual([])
  })

  it('warns when the playlist goes back (players replay)', () => {
    diag.playlist('7', URL0, playlist(100), 200)
    diag.playlist('7', URL0, playlist(98), 200)
    expect(warnings.join('\n')).toMatch(/went BACK from sequence 100 to 98/)
  })

  it('warns when a segment is fetched twice, or the player skips ahead', () => {
    diag.playlist('7', URL0, playlist(100, 6), 200)
    fetchSeg(100)
    fetchSeg(100)
    fetchSeg(103)
    expect(warnings.join('\n')).toMatch(/segment 100 fetched again/)
    expect(warnings.join('\n')).toMatch(/skipped from segment 100 to 103 \(2 missed\)/)
  })

  it('warns when a segment downloads slower than it plays', () => {
    diag.playlist('7', URL0, playlist(100), 200)
    fetchSeg(100, { ms: 7000, bytes: 3e6 })
    expect(warnings.join('\n')).toMatch(/segment 100: 3\.00 MB took 7\.0s for 6\.0s of video — slower than real time/)
  })

  it("warns when the source's timestamps jump back, and when audio drifts", () => {
    diag.playlist('7', URL0, playlist(100), 200)
    fetchSeg(100, { data: segmentBytes(50, 50) })
    fetchSeg(101, { data: segmentBytes(48, 48) })      // expected +6s, got −2s
    fetchSeg(102, { data: segmentBytes(54, 55) })      // audio now 1s later than video
    const all = warnings.join('\n')
    expect(all).toMatch(/timestamps in segment 101 jumped BACK 8\.0s/)
    expect(all).toMatch(/audio moved later by 1\.00s relative to video in segment 102/)
  })

  it('warns about discontinuities and slow playlist reloads', () => {
    diag.playlist('7', URL0, playlist(100, 3, '#EXT-X-DISCONTINUITY\n'), 3500)
    const all = warnings.join('\n')
    expect(all).toMatch(/playlist reload took 3\.5s/)
    expect(all).toMatch(/discontinuity before segment 100/)
  })
})
