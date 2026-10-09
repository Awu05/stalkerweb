import { describe, it, expect, beforeEach } from 'vitest'
import { LiveBuffer } from '../lib/liveBuffer.js'
import { parsePlaylist } from '../lib/restartSmoother.js'

const BASE = 'http://cdn/live/mono.m3u8?token=t'
// A source playlist of 6 s segments segN.ts, from number `seq`, `n` long.
const source = (seq, n, { disc = [], dseq = 0 } = {}) =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${seq}\n${dseq ? `#EXT-X-DISCONTINUITY-SEQUENCE:${dseq}\n` : ''}` +
  Array.from({ length: n }, (_, i) => `${disc.includes(seq + i) ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:6.0,\nseg${seq + i}.ts?token=t`).join('\n') + '\n'
const names = (body) => parsePlaylist(body).segments.map((s) => Number(/seg(\d+)/.exec(s.uri)[1]))
const header = (body, tag) => parsePlaylist(body).header.find((l) => l.startsWith(tag))

describe('LiveBuffer', () => {
  let t, buf, logs, failing
  const settle = () => buf.queue
  const at = (s) => { t += s * 1000; buf.tick() }

  beforeEach(() => {
    t = 0
    logs = []
    failing = new Set()
    buf = new LiveBuffer({
      seconds: 30,
      now: () => t,
      download: async (url) => (failing.has(Number(/seg(\d+)/.exec(url)[1])) ? null : Buffer.from(url)),
      logger: { info: (_t, m) => logs.push(m), warn: (_t, m) => logs.push(m) },
      channel: '7',
    })
  })

  it('releases the oldest part of the window at once and holds the newest 30 s', async () => {
    buf.feed(source(100, 8), BASE)        // 48 s listed
    await settle()
    const pl = buf.playlist()
    expect(names(pl)).toEqual([100, 101, 102])
    expect(header(pl, '#EXT-X-MEDIA-SEQUENCE')).toBe('#EXT-X-MEDIA-SEQUENCE:0')
    expect(buf.cushion()).toBe(30)
    expect(buf.bytesFor('http://cdn/live/seg101.ts?token=x').toString()).toContain('seg101.ts')
  })

  it('releases one segment per segment length, as players play them', async () => {
    buf.feed(source(100, 8), BASE)
    await settle()
    at(5.9)
    expect(names(buf.playlist()).at(-1)).toBe(102)
    at(0.1)
    expect(names(buf.playlist()).at(-1)).toBe(103)
    at(6)
    expect(names(buf.playlist()).at(-1)).toBe(104)
  })

  it('keeps players going through a stall in the source, from the cushion', async () => {
    buf.feed(source(100, 8), BASE)
    await settle()
    // The source lists nothing new for 30 s; players still get a segment every 6 s.
    for (let i = 1; i <= 5; i++) {
      at(6)
      expect(names(buf.playlist()).at(-1)).toBe(102 + i)
    }
    expect(logs.join('\n')).not.toMatch(/ran dry/)
    // A burst after the stall refills the cushion rather than reaching players early.
    buf.feed(source(104, 8), BASE)
    await settle()
    buf.tick()
    expect(names(buf.playlist()).at(-1)).toBe(107)
    expect(buf.cushion()).toBe(24)
  })

  it('says when the cushion runs out, and players wait', async () => {
    buf.feed(source(100, 4), BASE)        // 24 s: 3 released, 6 s held
    await settle()
    at(6)
    expect(names(buf.playlist()).at(-1)).toBe(103)
    at(7.5)
    expect(names(buf.playlist()).at(-1)).toBe(103)
    expect(logs.join('\n')).toMatch(/ran dry/)
    // The next segment goes out as soon as it arrives.
    buf.feed(source(101, 4), BASE)
    await settle()
    expect(names(buf.playlist()).at(-1)).toBe(104)
  })

  it('numbers players see run on across a segment that failed to download, with the break marked', async () => {
    failing.add(103)
    buf.feed(source(100, 8), BASE)
    await settle()
    at(6)
    const pl = parsePlaylist(buf.playlist())
    expect(pl.segments.map((s) => Number(/seg(\d+)/.exec(s.uri)[1]))).toEqual([100, 101, 102, 104])
    expect(pl.header).toContain('#EXT-X-MEDIA-SEQUENCE:0')
    expect(pl.segments.at(-1).disc).toBe(true)
  })

  it("carries the source's discontinuities", async () => {
    buf.feed(source(100, 8, { disc: [104] }), BASE)
    await settle()
    at(6)
    at(6)
    const pl = parsePlaylist(buf.playlist())
    expect(pl.segments.map((s) => s.disc)).toEqual([false, false, false, false, true])
  })

  it('skips the oldest held content when the source bursts far beyond the cushion', async () => {
    buf.feed(source(100, 4), BASE)
    await settle()
    buf.feed(source(104, 10), BASE)       // 60 s more at once
    await settle()
    expect(buf.cushion()).toBeLessThanOrEqual(30)
    expect(logs.join('\n')).toMatch(/buffer full — skipped/)
    at(6)
    const pl = parsePlaylist(buf.playlist())
    expect(pl.segments.at(-1).disc).toBe(true)   // the jump is marked
  })

  it('lists at most 6 released segments and forgets older bytes', async () => {
    buf.feed(source(100, 8), BASE)
    await settle()
    for (let i = 0; i < 4; i++) {
      at(6)
      buf.feed(source(108 + i, 1), BASE)
      await settle()
    }
    for (let i = 0; i < 10; i++) at(6)
    expect(names(buf.playlist())).toHaveLength(6)
    expect(buf.bytesFor('http://cdn/live/seg100.ts')).toBeNull()
  })

  it('stays out of encrypted and fMP4 streams', () => {
    buf.feed('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\na.m4s\n', BASE)
    expect(buf.unsupported).toBe(true)
    expect(buf.playlist()).toBeNull()
  })
})
