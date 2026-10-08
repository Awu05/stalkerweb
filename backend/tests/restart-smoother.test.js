import { describe, it, expect, beforeEach } from 'vitest'
import { RestartSmoother, parsePlaylist, timeFromName } from '../lib/restartSmoother.js'

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

  // ── Servers that name segments by time (Flussonic), as measured ───────────
  // name(t): the segment starting t seconds after 20:41:00, 6 s long unless given.
  const name = (t, ms = 6000) => {
    const m = Math.floor(t / 60), sec = t % 60
    return `tracks-v1a1/2026/10/08/20/${String(41 + m).padStart(2, '0')}/${String(sec).padStart(2, '0')}-${String(ms).padStart(5, '0')}.ts?token=t`
  }
  // A playlist from [time, disc?] pairs, numbered from `seq` as the server did.
  const timed = (seq, segs) =>
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:${seq}\n` +
    segs.map(([t, disc, ms]) => `${disc ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:${(ms ?? 6000) / 1000},\n${name(t, ms)}`).join('\n') + '\n'
  const uris = (out) => parsePlaylist(out).segments.map((x) => /20\/(\d+\/\d+)-/.exec(x.uri)[1])

  it('reads start and length from time-based names', () => {
    expect(timeFromName('http://h/x/tracks-v1a1/2026/10/08/20/42/14-06474.ts?token=a'))
      .toEqual({ start: Date.UTC(2026, 9, 8, 20, 42, 14) / 1000, dur: 6.474 })
    expect(timeFromName('http://h/x/seg100.ts')).toBeNull()
  })

  it('keeps numbering steady when the source renumbers and repeats after a restart', async () => {
    // Before: 20:41:56, 20:42:02, 20:42:08, 20:42:14 numbered 547617–547620.
    const before = await smoother.rewrite('k', BASE, timed(547617, [[56], [62], [68], [74, false, 6474]]))
    expect(parsePlaylist(before).header).toContain('#EXT-X-MEDIA-SEQUENCE:547617')
    // The restart: the same files renumbered 10 ahead, then new files from
    // 20:42:03 — content already listed — and only 20:42:21 actually new.
    const after = await smoother.rewrite('k', BASE, timed(547628, [
      [68], [74, false, 6474], [63, true], [69], [75], [81],
    ]))
    const p = parsePlaylist(after)
    expect(p.header).toContain('#EXT-X-MEDIA-SEQUENCE:547619')     // where it was, not 547628
    expect(uris(after)).toEqual(['42/08', '42/14', '42/21'])
    expect(p.segments[2].disc).toBe(true)                          // the restart stays marked
    expect(drops).toEqual([547630, 547631, 547632])
    // Next reload: the old files are gone; 20:42:21 kept its number.
    const later = parsePlaylist(await smoother.rewrite('k', BASE, timed(547631, [[75], [81], [87]])))
    expect(later.header).toContain('#EXT-X-MEDIA-SEQUENCE:547621')
    expect(later.header).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1')
    expect(later.segments.map((x) => x.disc)).toEqual([false, false])
  })

  it('leaves out content repeated from long before, not just the last segment', async () => {
    await smoother.rewrite('k', BASE, timed(10, [[60], [66], [72], [78]]))
    // The source went back 20 s.
    const out = await smoother.rewrite('k', BASE, timed(14, [[60, true], [66], [72], [78], [84]]))
    expect(uris(out)).toEqual(['42/00', '42/06', '42/12', '42/18', '42/24'])
    expect(parsePlaylist(out).header).toContain('#EXT-X-MEDIA-SEQUENCE:10')
  })

  it('keeps the last playlist while the source only repeats', async () => {
    const first = await smoother.rewrite('k', BASE, timed(10, [[60], [66]]))
    const out = await smoother.rewrite('k', BASE, timed(20, [[50, true], [56], [62]]))
    expect(out).toBe(first)
  })

  it('starts after a gap when a listed segment disappears', async () => {
    await smoother.rewrite('k', BASE, timed(10, [[60], [66], [72]]))
    // 20:42:06 is no longer listed, but the segments around it are.
    const out = await smoother.rewrite('k', BASE, timed(10, [[60], [72], [78]]))
    expect(uris(out)).toEqual(['42/12', '42/18'])
    expect(parsePlaylist(out).header).toContain('#EXT-X-MEDIA-SEQUENCE:12')
  })

  it('treats a clock that went far back as a new clock, not a repeat', async () => {
    await smoother.rewrite('k', BASE, timed(10, [[600], [606]]))   // 20:51:00, 20:51:06
    const out = parsePlaylist(await smoother.rewrite('k', BASE, timed(12, [[0, true], [6]])))   // 20:41:00
    expect(drops).toEqual([])
    expect(out.header).toContain('#EXT-X-MEDIA-SEQUENCE:12')
  })

  it('gives up leaving out repeats after 45 s in a row', async () => {
    await smoother.rewrite('k', BASE, timed(10, [[60], [66], [72], [78], [84], [90], [96], [102], [108]]))
    // Back 59 s (new files, cut a second off the old ones), and it keeps
    // coming from there: 7 repeats (42 s) are left out, then it resyncs.
    const out = await smoother.rewrite('k', BASE, timed(19, [[55, true], [61], [67], [73], [79], [85], [91], [97], [103], [109]]))
    expect(drops.length).toBe(7)
    expect(uris(out)).toEqual(['42/37', '42/43', '42/49'])
    expect(parsePlaylist(out).header).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1')
  })

  it('passes a time-named stream without restarts through unchanged', async () => {
    const a = timed(10, [[60], [66], [72]])
    const b = timed(11, [[66], [72], [78]])
    expect(await smoother.rewrite('k', BASE, a)).toBe(a)
    expect(await smoother.rewrite('k', BASE, b)).toBe(b)
  })

  it('passes byte-range playlists through', async () => {
    const body = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6,\n#EXT-X-BYTERANGE:100@0\nall.ts\n#EXTINF:6,\n#EXT-X-BYTERANGE:100@100\nall.ts\n'
    expect(await smoother.rewrite('k', BASE, body)).toBe(body)
  })
})

describe('RestartSmoother — review cases', () => {
  const quiet = { info: () => {}, warn: () => {} }
  const numbered = (seq, names, extra = {}) =>
    `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${seq}\n${extra.header ?? ''}` +
    names.map((n) => `${(extra.disc ?? []).includes(n) ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:6.0,\n${n}`).join('\n') + '\n'
  const seqOf = (out) => parsePlaylist(out).header.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:')).split(':')[1] * 1
  const urisOf = (out) => parsePlaylist(out).segments.map((s) => s.uri)
  // name(t): a Flussonic-style name for the segment starting t s after 20:41:00.
  const name = (t, ext = 'ts') => {
    const m = Math.floor(t / 60), sec = t % 60
    return `tracks-v1a1/2026/10/08/20/${String(41 + m).padStart(2, '0')}/${String(sec).padStart(2, '0')}-06000.${ext}`
  }

  it('keeps a long window whole and in order (more segments than it remembers)', async () => {
    const sm = new RestartSmoother({ probe: async () => null, logger: quiet })
    const segs = (from) => Array.from({ length: 400 }, (_, i) => `seg${from + i}.ts`)
    const a = await sm.rewrite('k', BASE, numbered(1, segs(1)))
    expect(urisOf(a)).toHaveLength(400)
    const b = await sm.rewrite('k', BASE, numbered(2, segs(2)))
    expect(seqOf(b)).toBe(2)
    expect(urisOf(b)).toEqual(segs(2))
  })

  it('keeps EXT-X-MAP when the segment carrying it is left out', async () => {
    const sm = new RestartSmoother({ probe: async () => null, logger: quiet })
    const map = '#EXT-X-MAP:URI="init.mp4"\n'
    const m = (t) => name(t, 'm4s')
    await sm.rewrite('k', BASE, numbered(10, [m(60), m(66)], { header: map }))
    // A restart: 20:42:05 repeats most of 20:42:06 and is left out.
    await sm.rewrite('k', BASE, numbered(10, [m(60), m(66), m(65), m(72)], { header: map, disc: [m(65)] }))
    // Later the left-out segment heads the window, and the server puts the map on it.
    const out = await sm.rewrite('k', BASE, numbered(12, [m(65), m(72), m(78)], { header: map, disc: [m(65)] }))
    const p = parsePlaylist(out)
    expect(p.segments.map((s) => s.uri)).toEqual([m(72), m(78)])
    expect(out.indexOf('#EXT-X-MAP')).toBeGreaterThan(-1)
    expect(out.indexOf('#EXT-X-MAP')).toBeLessThan(out.indexOf(m(72)))
  })

  it('keeps numbering going forward when the source reuses file names', async () => {
    const sm = new RestartSmoother({ probe: async () => null, logger: quiet })
    let last = -1
    for (let head = 3; head < 40; head++) {
      const names = [head - 3, head - 2, head - 1, head].map((n) => `seg${n % 10}.ts`)
      const out = await sm.rewrite('k', BASE, numbered(head - 3, names))
      const seq = seqOf(out)
      expect(seq, `reload ${head}`).toBeGreaterThanOrEqual(last)
      expect(urisOf(out).at(-1)).toBe(`seg${head % 10}.ts`)   // the newest segment is always there
      last = seq
    }
  })

  it('numbers each segment once when two players reload at the same time', async () => {
    const sm = new RestartSmoother({
      // A slow probe; 102 continues 101 (a restart that repeats nothing), so it is kept.
      probe: (url) => new Promise((r) => setTimeout(() => r({ video: url.includes('seg102') ? 1006 : 1000, audio: null }), 30)),
      logger: quiet,
    })
    await sm.rewrite('k', BASE, numbered(100, ['seg100.ts', 'seg101.ts']))
    const body = numbered(101, ['seg101.ts', 'seg102.ts', 'seg103.ts'], { disc: ['seg102.ts'] })
    const [a, b] = await Promise.all([sm.rewrite('k', BASE, body), sm.rewrite('k', BASE, body)])
    expect(a).toBe(body)   // nothing to change
    expect(b).toBe(body)
    const next = await sm.rewrite('k', BASE, numbered(102, ['seg102.ts', 'seg103.ts', 'seg104.ts']))
    expect(urisOf(next)).toEqual(['seg102.ts', 'seg103.ts', 'seg104.ts'])
    expect(seqOf(next)).toBe(102)
  })

  it('stops holding back repeats before players give up on a still playlist', async () => {
    let t = 0
    const sm = new RestartSmoother({ probe: async () => null, logger: quiet, now: () => t })
    await sm.rewrite('k', BASE, numbered(10, [name(60), name(66), name(72)]))
    // The source goes back 29 s and replays in real time, one segment per
    // reload. After 2.5 target durations (15 s) with nothing new, the next
    // segment is kept, with the break marked.
    const w = []
    let out
    for (const at of [49, 55, 61]) {
      t += 6000
      w.push(name(at))
      out = await sm.rewrite('k', BASE, numbered(20, w, { disc: [name(49)] }))
    }
    const p = parsePlaylist(out)
    expect(p.segments.map((s) => s.uri)).toEqual([name(61)])
    expect(p.header).toContain('#EXT-X-MEDIA-SEQUENCE:13')
    expect(p.header).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1')
  })

  it('logs a renumbering once, not again when the old segments leave', async () => {
    const lines = []
    const sm = new RestartSmoother({ probe: async () => null, logger: { info: (_t, m) => lines.push(m), warn: () => {} } })
    await sm.rewrite('k', BASE, numbered(100, ['A.ts', 'B.ts', 'C.ts']))
    await sm.rewrite('k', BASE, numbered(110, ['A.ts', 'B.ts', 'C.ts', 'D.ts']))
    await sm.rewrite('k', BASE, numbered(111, ['B.ts', 'C.ts', 'D.ts', 'E.ts']))
    await sm.rewrite('k', BASE, numbered(113, ['D.ts', 'E.ts', 'F.ts']))
    expect(lines.filter((l) => l.includes('renumbered'))).toEqual([expect.stringContaining('(+10)')])
  })

  it('never moves the playlist back for an older playlist from an out-of-step server', async () => {
    const sm = new RestartSmoother({ probe: async () => null, logger: quiet })
    await sm.rewrite('k', BASE, numbered(10, ['s10.ts', 's11.ts', 's12.ts']))
    const cur = await sm.rewrite('k', BASE, numbered(12, ['s12.ts', 's13.ts', 's14.ts']))
    const older = await sm.rewrite('k', BASE, numbered(9, ['s9.ts', 's10.ts', 's11.ts', 's12.ts']))
    expect(seqOf(older)).toBeGreaterThanOrEqual(seqOf(cur))
    const after = await sm.rewrite('k', BASE, numbered(13, ['s13.ts', 's14.ts', 's15.ts']))
    expect(urisOf(after)).toEqual(['s13.ts', 's14.ts', 's15.ts'])
    expect(seqOf(after)).toBe(13)
  })
})
