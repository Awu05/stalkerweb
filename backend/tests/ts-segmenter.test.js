import { describe, it, expect } from 'vitest'
import { TsSegmenter } from '../stalker/TsSegmenter.js'
import { makeTs, pidOf, PMT_PID, AUDIO_PID, startsWithKeyframe } from './helpers/makeTs.js'

const listed = (pl) => [...pl.matchAll(/^(seg\d+\.ts)$/gm)].map((m) => m[1])
const durations = (pl) => [...pl.matchAll(/^#EXTINF:([\d.-]+),$/gm)].map((m) => Number(m[1]))

describe('TsSegmenter', () => {
  it('cuts at keyframes into ~4 s pieces, each starting with PAT and PMT', () => {
    const s = new TsSegmenter()
    expect(s.playlist()).toBeNull()
    s.push(makeTs({ seconds: 13, keyEvery: 2 }))
    const names = listed(s.playlist())
    expect(names).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])   // the last, open piece isn't listed
    for (const n of names) {
      const b = s.segment(n)
      expect(b.length % 188).toBe(0)
      expect(b[0]).toBe(0x47); expect(pidOf(b, 0)).toBe(0); expect(pidOf(b, 188)).toBe(PMT_PID)
      expect(startsWithKeyframe(b)).toBe(true)
    }
    expect(s.segment('seg3.ts')).toBeNull()
    const pl = s.playlist()
    expect(pl).toMatch(/^#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n/)
    expect(pl.match(/^#EXTINF:4\.000,$/gm)).toHaveLength(3)
    expect(pl).not.toMatch(/#EXT-X-ENDLIST/)
  })

  it('takes bytes split anywhere, not on packet boundaries', () => {
    // Keyframes marked only by the random-access flag here.
    const ts = makeTs({ seconds: 13, keyEvery: 2, mark: 'rai' })
    const whole = new TsSegmenter()
    whole.push(ts)
    const split = new TsSegmenter()
    for (let i = 0; i < ts.length; i += 7) split.push(ts.subarray(i, i + 7))
    expect(listed(split.playlist())).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    expect(split.playlist()).toBe(whole.playlist())
    for (const n of listed(whole.playlist())) {
      expect(split.segment(n).equals(whole.segment(n))).toBe(true)
      expect(startsWithKeyframe(split.segment(n))).toBe(true)
    }
  })

  it('re-aligns on the sync byte after junk', () => {
    const ts = makeTs({ seconds: 13, keyEvery: 2 })
    const s = new TsSegmenter()
    s.push(Buffer.from([0x00, 0x47, 0x12, 0x34]))   // junk, with a false sync byte in it
    s.push(ts)
    expect(listed(s.playlist())).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    expect(startsWithKeyframe(s.segment('seg0.ts'))).toBe(true)
  })

  it('keeps a window of 10 pieces and drops older ones', () => {
    const s = new TsSegmenter()
    s.push(makeTs({ seconds: 60, keyEvery: 2 }))
    const pl = s.playlist()
    const names = listed(pl)
    expect(names).toHaveLength(10)
    expect(names[0]).toBe('seg4.ts')
    expect(names[9]).toBe('seg13.ts')
    expect(pl).toMatch(/^#EXT-X-MEDIA-SEQUENCE:4$/m)
    expect(s.segment('seg0.ts')).toBeNull()
    expect(s.segment('seg13.ts')).not.toBeNull()
  })

  it('marks the piece after a break with EXT-X-DISCONTINUITY', () => {
    let t = 0
    const s = new TsSegmenter({ now: () => t })
    s.push(makeTs({ seconds: 13, keyEvery: 2, startPts: 90000 * 100 }))
    t = 1500
    s.discontinuity()
    s.push(makeTs({ seconds: 9, keyEvery: 2 }))   // PTS restarts at 0
    const pl = s.playlist()
    expect(listed(pl)).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts', 'seg4.ts', 'seg5.ts'])
    // The open piece (12 s to 12.96 s, 25 fps) gets the time its frames cover: 24 frames + one.
    expect(pl).toMatch(/#EXTINF:1\.000,\nseg3\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4\.000,\nseg4\.ts/)
    expect(pl.match(/#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1)
    expect(durations(pl).every((d) => d > 0)).toBe(true)
    expect(startsWithKeyframe(s.segment('seg4.ts'))).toBe(true)

    // A PTS jump of more than 10 s is a break too, without discontinuity().
    const j = new TsSegmenter({ now: () => 0 })
    j.push(makeTs({ seconds: 13, keyEvery: 2, startPts: 90000 * 100 }))
    j.push(makeTs({ seconds: 9, keyEvery: 2 }))
    const jp = j.playlist()
    expect(jp).toMatch(/#EXTINF:1\.000,\nseg3\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4\.000,\nseg4\.ts/)
    expect(durations(jp).every((d) => d > 0)).toBe(true)
  })

  it('does not count a stall before a break in the piece before it', () => {
    for (const call of [false, true]) {
      let t = 0
      const s = new TsSegmenter({ now: () => t })
      s.push(makeTs({ seconds: 13, keyEvery: 2, startPts: 90000 * 100 }))
      t = 20000   // the source stalls 20 s…
      if (call) s.discontinuity()
      s.push(makeTs({ seconds: 9, keyEvery: 2 }))   // …then comes back with its PTS reset
      const pl = s.playlist()
      expect(pl).toMatch(/#EXTINF:1\.000,\nseg3\.ts\n#EXT-X-DISCONTINUITY\n/)
      expect(pl).toMatch(/^#EXT-X-TARGETDURATION:4$/m)
    }
  })

  it('times a piece of one frame by its packets\' arrival, to its last packet', () => {
    // One frame at 1 fps: its PTS gives no length, so arrival time does.
    const ts = makeTs({ seconds: 1, fps: 1, keyEvery: 1 })
    let audioAt = 0
    while (pidOf(ts, audioAt) !== AUDIO_PID) audioAt += 188
    let t = 0
    const s = new TsSegmenter({ now: () => t })
    s.push(ts.subarray(0, audioAt))   // PAT, PMT and the frame at 0 ms
    t = 500
    s.push(ts.subarray(audioAt))      // its audio at 500 ms
    t = 5000                          // a stall, then the break
    s.discontinuity()
    expect(s.playlist()).toMatch(/#EXTINF:0\.500,\nseg0\.ts/)
  })

  it('cuts only at real keyframes when every frame carries parameter sets', () => {
    for (const video of [0x1b, 0x24]) {
      const s = new TsSegmenter()
      s.push(makeTs({ seconds: 13, keyEvery: 3, spsEvery: true, video }))   // keyframes at 0, 3, 6, 9, 12 s
      const pl = s.playlist()
      expect(listed(pl)).toEqual(['seg0.ts', 'seg1.ts'])
      expect(durations(pl)).toEqual([6, 6])
      for (const n of listed(pl)) expect(startsWithKeyframe(s.segment(n))).toBe(true)
    }
  })

  it('closes a piece that outgrows the size cap instead of dropping it', () => {
    // A high bitrate and a long GOP: each piece passes the cap well before a keyframe.
    const cap = 400_000
    const s = new TsSegmenter({ maxPieceBytes: cap, windowSize: 20 })
    const ts = makeTs({ seconds: 25, keyEvery: 10, frameBytes: 8000 })
    s.push(ts)
    const pl = s.playlist()
    expect(pl).not.toBeNull()
    const names = listed(pl)
    expect(names.length).toBeGreaterThanOrEqual(11)
    for (const n of names) {
      const b = s.segment(n)
      expect(pidOf(b, 0)).toBe(0); expect(pidOf(b, 188)).toBe(PMT_PID)
      expect(b.length).toBeLessThan(cap + 60 * 188)   // past the cap by at most about a frame
    }
    expect(durations(pl).every((d) => d > 0 && d <= 4)).toBe(true)
    expect(durations(pl).reduce((a, d) => a + d, 0)).toBeGreaterThan(20)
    expect(pl).not.toMatch(/DISCONTINUITY/)
  })

  it('carries on across the 33-bit PTS wrap', () => {
    const s = new TsSegmenter()
    s.push(makeTs({ seconds: 13, keyEvery: 2, startPts: 2 ** 33 - 90000 * 6 }))   // wraps 6 s in
    const pl = s.playlist()
    expect(listed(pl)).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    expect(pl.match(/^#EXTINF:4\.000,$/gm)).toHaveLength(3)
    expect(pl).not.toMatch(/DISCONTINUITY/)
  })

  it('finds keyframes in HEVC too', () => {
    const s = new TsSegmenter()
    s.push(makeTs({ seconds: 13, keyEvery: 2, video: 0x24 }))
    const names = listed(s.playlist())
    expect(names).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    for (const n of names) expect(startsWithKeyframe(s.segment(n))).toBe(true)
    expect(s.playlist().match(/^#EXTINF:4\.000,$/gm)).toHaveLength(3)
    expect(s.codecs.videoType).toBe(0x24)
  })

  it('reports the stream types, for a "can\'t cast this" message', () => {
    const s = new TsSegmenter()
    expect(s.codecs).toEqual({ videoType: null, audioType: null })
    s.push(makeTs({ seconds: 2, video: 0x02, audio: 0x03 }))
    expect(s.codecs).toEqual({ videoType: 2, audioType: 3 })
  })

  it('cuts by time when a stream has no keyframe marks at all', () => {
    const s = new TsSegmenter()
    s.push(makeTs({ seconds: 17, keyEvery: 0 }))
    const pl = s.playlist()
    // It waits up to one piece's length for a keyframe, then cuts by the clock.
    expect(listed(pl)).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    expect(durations(pl)).toEqual([4, 4, 4])
    expect(pl).toMatch(/^#EXT-X-TARGETDURATION:4$/m)
  })
})
