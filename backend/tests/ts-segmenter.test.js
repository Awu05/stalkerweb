import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
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
    s.push(makeTs({ seconds: 25, keyEvery: 0 }))
    const pl = s.playlist()
    // It waits up to three pieces' length for a keyframe (as long as it takes
    // to call a stream keyless), then cuts by the clock: 12–16, 16–20, 20–24 s.
    expect(listed(pl)).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    expect(durations(pl)).toEqual([4, 4, 4])
    expect(pl).toMatch(/^#EXT-X-TARGETDURATION:4$/m)
    // Its pieces don't start on keyframes, so the playlist doesn't say they do.
    expect(pl).not.toMatch(/#EXT-X-INDEPENDENT-SEGMENTS/)
  })

  it('waits for the first keyframe of a long GOP (8 s) rather than starting without one', () => {
    for (const before of [false, true]) {
      let t = 0
      const s = new TsSegmenter({ now: () => t })
      if (before) {   // and after a break, the same
        s.push(makeTs({ seconds: 13, keyEvery: 2, startPts: 90000 * 100 }))
        t = 1000
        s.discontinuity()
      }
      s.push(makeTs({ seconds: 30, keyEvery: 8, firstKeyAt: 6 }))   // joined 6 s before a keyframe
      const pl = s.playlist()
      const after = listed(pl).slice(before ? 4 : 0)
      expect(after.length).toBeGreaterThanOrEqual(2)
      for (const n of after) expect(startsWithKeyframe(s.segment(n)), n).toBe(true)
      expect(durations(pl).slice(before ? 4 : 0)).toEqual([8, 8])   // 6–14, 14–22 s
      expect(pl).toMatch(/#EXT-X-INDEPENDENT-SEGMENTS/)
    }
  })

  it('drops the cut-off packet of the old source at a break', () => {
    const ts = makeTs({ seconds: 13, keyEvery: 2 })
    const s = new TsSegmenter()
    s.push(ts.subarray(0, ts.length - 88))   // the source broke off mid-packet
    expect(s.rest.length).toBe(100)
    s.discontinuity()
    expect(s.rest.length).toBe(0)
    // The new source's first 88 bytes would have finished the old packet.
    const next = makeTs({ seconds: 9, keyEvery: 2 })
    const fresh = new TsSegmenter()
    fresh.push(next)
    s.push(next.subarray(0, 88))
    s.push(next.subarray(88))
    const names = listed(s.playlist())
    expect(s.segment(names[names.length - 1]).equals(fresh.segment('seg1.ts'))).toBe(true)
  })

  it('does not call pieces independent when the size cap cut them between keyframes', () => {
    const s = new TsSegmenter({ maxPieceBytes: 400_000 })
    s.push(makeTs({ seconds: 25, keyEvery: 10, frameBytes: 8000 }))
    expect(s.playlist()).not.toMatch(/#EXT-X-INDEPENDENT-SEGMENTS/)
    const ok = new TsSegmenter()
    ok.push(makeTs({ seconds: 13, keyEvery: 2 }))
    expect(ok.playlist()).toMatch(/#EXT-X-INDEPENDENT-SEGMENTS/)
  })

  it('counts a discontinuity that left the window in #EXT-X-DISCONTINUITY-SEQUENCE', () => {
    let t = 0
    const s = new TsSegmenter({ windowSize: 2, now: () => t })
    s.push(makeTs({ seconds: 13, keyEvery: 2, startPts: 90000 * 100 }))
    t = 1000
    s.discontinuity()
    s.push(makeTs({ seconds: 9, keyEvery: 2 }))   // seg4 starts after the break
    let pl = s.playlist()
    expect(listed(pl)).toEqual(['seg4.ts', 'seg5.ts'])
    expect(pl).toMatch(/#EXT-X-DISCONTINUITY\n#EXTINF:4\.000,\nseg4\.ts/)
    expect(pl).not.toMatch(/DISCONTINUITY-SEQUENCE/)
    s.push(makeTs({ seconds: 10, keyEvery: 2, startPts: 90000 * 9 }))   // keyframes at 9, 11, … 17 s
    pl = s.playlist()
    expect(listed(pl)).toEqual(['seg6.ts', 'seg7.ts'])
    expect(pl).toMatch(/^#EXT-X-DISCONTINUITY-SEQUENCE:1$/m)
    expect(pl).not.toMatch(/^#EXT-X-DISCONTINUITY$/m)
    s.push(makeTs({ seconds: 20, keyEvery: 2, startPts: 90000 * 19 }))   // and once it's out of the kept pieces too
    expect(s.segment('seg4.ts')).toBeNull()
    expect(s.playlist()).toMatch(/^#EXT-X-DISCONTINUITY-SEQUENCE:1$/m)
  })

  it('follows a PMT that changes mid-stream (H.264 to HEVC), without a break', () => {
    const s = new TsSegmenter({ windowSize: 20 })
    s.push(makeTs({ seconds: 13, keyEvery: 2 }))
    expect(s.codecs.videoType).toBe(0x1b)
    s.push(makeTs({ seconds: 13, keyEvery: 2, video: 0x24, startPts: 90000 * 13 }))
    expect(s.codecs.videoType).toBe(0x24)
    const pl = s.playlist()
    expect(pl).not.toMatch(/DISCONTINUITY/)
    const last = s.segment(listed(pl).at(-1))
    // The piece starts with the new PMT, whose first stream is HEVC (0x24).
    expect(pidOf(last, 188)).toBe(PMT_PID)
    expect(last.subarray(188, 376).includes(Buffer.from([0x24, 0xe1, 0x00]))).toBe(true)
    expect(startsWithKeyframe(last)).toBe(true)
  })

  it('takes B-frames (PTS a frame back now and then) as one stream', () => {
    const s = new TsSegmenter()
    s.push(makeTs({ seconds: 13, keyEvery: 2, bFrames: true }))
    const pl = s.playlist()
    expect(pl).not.toMatch(/DISCONTINUITY/)
    expect(listed(pl)).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    expect(durations(pl)).toEqual([4, 4, 4])
    for (const n of listed(pl)) expect(startsWithKeyframe(s.segment(n))).toBe(true)
  })

  it('still serves the two pieces before the window, for a player a little behind', () => {
    const s = new TsSegmenter()
    s.push(makeTs({ seconds: 60, keyEvery: 2 }))
    expect(listed(s.playlist())[0]).toBe('seg4.ts')
    expect(s.segment('seg3.ts')).not.toBeNull()
    expect(s.segment('seg2.ts')).not.toBeNull()
    expect(s.segment('seg1.ts')).toBeNull()
  })

  it('takes a step back in time of more than a second as a break, a small one not', () => {
    const at = (sec) => 90000 * (100 + sec)
    const back = new TsSegmenter()
    back.push(makeTs({ seconds: 13, keyEvery: 2, startPts: at(0) }))
    back.push(makeTs({ seconds: 9, keyEvery: 2, startPts: at(13 - 2) }))   // 2 s back: a restart, not B-frames
    expect(back.playlist()).toMatch(/#EXT-X-DISCONTINUITY\n/)
    const small = new TsSegmenter()
    small.push(makeTs({ seconds: 13, keyEvery: 2, startPts: at(0) }))
    small.push(makeTs({ seconds: 9, keyEvery: 2, startPts: at(13 - 0.5) }))
    expect(small.playlist()).not.toMatch(/#EXT-X-DISCONTINUITY/)
  })

  it('never lowers #EXT-X-TARGETDURATION once a longer piece was listed', () => {
    const s = new TsSegmenter({ windowSize: 2 })
    s.push(makeTs({ seconds: 13, keyEvery: 6 }))
    expect(s.playlist()).toMatch(/^#EXT-X-TARGETDURATION:6$/m)
    s.push(makeTs({ seconds: 20, keyEvery: 2, startPts: 90000 * 13 }))
    const pl = s.playlist()
    expect(durations(pl)).toEqual([4, 4])   // the 6 s pieces are gone from the list…
    expect(pl).toMatch(/^#EXT-X-TARGETDURATION:6$/m)   // …and the target stays
  })
  it('cuts the same bytes as before, pushed in any sizes', () => {
    // Pieces' sha256 (first 16 hex digits) from the segmenter as it was before
    // it kept its pieces in one growing buffer: the bytes mustn't change.
    const ts = Buffer.concat([Buffer.from([0x00, 0x47, 0x12]), makeTs({ seconds: 30, keyEvery: 2 }), Buffer.from([0x47, 0x00]),
      makeTs({ seconds: 9, keyEvery: 3, startPts: 90000 * 30 })])
    const s = new TsSegmenter({ windowSize: 20 })
    const sizes = [1, 187, 188, 189, 376, 1000, 4096, 65536]
    for (let i = 0, k = 0; i < ts.length; k++) { const n = sizes[k % sizes.length]; s.push(ts.subarray(i, i + n)); i += n }
    const names = listed(s.playlist())
    expect(names.map((n) => crypto.createHash('sha256').update(s.segment(n)).digest('hex').slice(0, 16))).toEqual([
      'fb5f3e1086e4435a', 'de9a64d526872602', 'ab7015caf721a360', '66caa8ca27ffc4ef',
      'd960e715c5473e8a', 'a42b71f9195ecad4', '88e75f5934b6bc8a', '8eb32d197c107ff6',
    ])
    expect(durations(s.playlist())).toEqual([4, 4, 4, 4, 4, 4, 4, 5])
  })

  it('keeps copies of the bytes, not views of the chunks it was given', () => {
    // A caller may reuse its buffer; a piece must not change with it (and
    // mustn't hold a whole chunk alive for a packet of it either).
    const ts = makeTs({ seconds: 13, keyEvery: 2 })
    const ref = new TsSegmenter()
    ref.push(Buffer.from(ts))
    const s = new TsSegmenter()
    const scratch = Buffer.alloc(4096)
    for (let i = 0; i < ts.length; i += scratch.length) {
      const n = ts.copy(scratch, 0, i, i + scratch.length)
      s.push(scratch.subarray(0, n))
      scratch.fill(0xaa)
    }
    expect(s.rest.length).toBeLessThan(188)
    for (const n of listed(ref.playlist())) expect(s.segment(n).equals(ref.segment(n)), n).toBe(true)
  })
})
