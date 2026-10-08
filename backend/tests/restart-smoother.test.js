import { describe, it, expect, beforeEach } from 'vitest'
import { RestartSmoother, parsePlaylist } from '../lib/restartSmoother.js'

const BASE = 'http://cdn/live/mono.m3u8?token=t'
// A playlist window starting at `seq`; `disc` marks segments preceded by a discontinuity.
const playlist = (seq, n, disc = []) =>
  `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${seq}\n` +
  Array.from({ length: n }, (_, i) => `${disc.includes(seq + i) ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:6.0,\nseg${seq + i}.ts?token=t`).join('\n') + '\n'

describe('parsePlaylist', () => {
  it('splits header, numbered segments and discontinuities', () => {
    const p = parsePlaylist(playlist(100, 3, [101]))
    expect(p.header).toEqual(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:100'])
    expect(p.segments.map((s) => [s.seq, s.uri, s.dur, s.disc])).toEqual([
      [100, 'seg100.ts?token=t', 6, false],
      [101, 'seg101.ts?token=t', 6, true],
      [102, 'seg102.ts?token=t', 6, false],
    ])
  })

  it('returns null for a master playlist', () => {
    expect(parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmono.m3u8\n')).toBeNull()
  })
})

describe('RestartSmoother', () => {
  let starts, probes, drops, smoother
  // Start timestamp of each segment number, as the source would encode it.
  const setStarts = (map) => { starts = map }

  beforeEach(() => {
    starts = {}
    probes = []
    drops = []
    smoother = new RestartSmoother({
      probe: async (url) => {
        const n = Number(/seg(\d+)\.ts/.exec(url)[1])
        probes.push(n)
        return n in starts ? { video: starts[n], audio: starts[n] } : null
      },
      onDrop: (ch, seq) => drops.push(seq),
      logger: { info: () => {}, warn: () => {} },
    })
  })

  it('passes a playlist without restarts through unchanged', async () => {
    const body = playlist(100, 3)
    expect(await smoother.rewrite('k', BASE, body)).toBe(body)
    expect(probes).toEqual([])
  })

  it('leaves out the segment after a restart that repeats what was just played', async () => {
    // 101 is 6 s long from 1000; 102 restarts at 1000.3 → repeats 5.7 s.
    setStarts({ 101: 1000, 102: 1000.3, 103: 1006.3 })
    await smoother.rewrite('k', BASE, playlist(100, 2))                   // 100, 101
    const out = await smoother.rewrite('k', BASE, playlist(101, 3, [102])) // 101, 102 (restart), 103
    expect(drops).toEqual([102])
    const p = parsePlaylist(out)
    expect(p.header).toContain('#EXT-X-MEDIA-SEQUENCE:101')
    expect(p.segments.map((s) => s.uri)).toEqual(['seg101.ts?token=t', 'seg103.ts?token=t'])
    // The break stays marked, now on the first segment after it.
    expect(p.segments[1].disc).toBe(true)
  })

  it('keeps numbering stable across reloads after a drop', async () => {
    setStarts({ 101: 1000, 102: 1000.3 })
    await smoother.rewrite('k', BASE, playlist(100, 3, [102]))       // judged here
    const next = parsePlaylist(await smoother.rewrite('k', BASE, playlist(102, 3)))  // 102 (dropped), 103, 104
    // 103 was served as number 102 (one drop before it) and stays so.
    expect(next.header).toContain('#EXT-X-MEDIA-SEQUENCE:102')
    expect(next.segments.map((s) => s.uri)).toEqual(['seg103.ts?token=t', 'seg104.ts?token=t'])
    // Once the dropped segment has left the window, numbering is unchanged.
    const later = parsePlaylist(await smoother.rewrite('k', BASE, playlist(104, 2)))
    expect(later.header).toContain('#EXT-X-MEDIA-SEQUENCE:103')
  })

  it('keeps restarts that continue, or move the clock somewhere unrelated', async () => {
    setStarts({ 101: 1000, 102: 1006.1, 104: 2000, 105: 5, 107: 3000, 108: 3005 })
    await smoother.rewrite('k', BASE, playlist(100, 3, [102]))   // 102 continues → keep
    await smoother.rewrite('k', BASE, playlist(103, 3, [105]))   // 105 resets to 5 s → keep
    await smoother.rewrite('k', BASE, playlist(106, 3, [108]))   // 108 repeats only 1 s of 6 → keep
    expect(drops).toEqual([])
  })

  it('keeps the segment when timestamps are unavailable', async () => {
    await smoother.rewrite('k', BASE, playlist(100, 3, [102]))
    expect(drops).toEqual([])
  })

  it('uses timestamps of segments already served instead of probing', async () => {
    smoother.recordPts('http://cdn/live/seg101.ts?token=t', { video: 1000, audio: 1000 })
    setStarts({ 102: 1000.4 })
    await smoother.rewrite('k', BASE, playlist(100, 3, [102]))
    expect(drops).toEqual([102])
    expect(probes).toEqual([102])   // only the new segment was probed
  })

  it('keeps separate state per stream', async () => {
    setStarts({ 101: 1000, 102: 1000.3 })
    await smoother.rewrite('a', BASE, playlist(100, 3, [102]))
    const b = parsePlaylist(await smoother.rewrite('b', BASE, playlist(102, 2)))
    expect(b.header).toContain('#EXT-X-MEDIA-SEQUENCE:102')   // stream b never dropped anything
  })
})
