import { describe, it, expect } from 'vitest'
import { getEventListeners } from 'events'
import { readSelfStream } from '../stalker/selfStreamReader.js'

const { ReadableStream, Response, AbortController, AbortSignal } = globalThis

// A body that sends `chunks`, then ends — or, with `hold`, stays open with
// nothing more to send (a live stream between packets).
const body = (chunks, { hold = false } = {}) => new ReadableStream({
  start(c) {
    for (const x of chunks) c.enqueue(new Uint8Array(Buffer.from(x)))
    if (!hold) c.close()
  },
})
const ts = (chunks, opts) => new Response(body(chunks, opts), { headers: { 'Content-Type': 'video/mp2t' } })
const m3u8 = (text) => new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
const text = (bufs) => bufs.map((b) => b.toString())
// A live media playlist: 4 segments from `k`, 1 s each.
const media = (k, extra = []) => m3u8(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${k}`, ...extra,
  ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:1.0,', `/seg/s${k + i}.ts`]), ''].join('\n'))
const segName = (url) => /\/seg\/(s\d+)\.ts$/.exec(new URL(url).pathname)?.[1]

describe('readSelfStream', () => {
  it('streams a raw TS body', async () => {
    const ctrl = new AbortController()
    const got = []
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, ua: init.headers['User-Agent'] })
      return ts(['ab', 'cd'], { hold: true })
    }
    const done = readSelfStream('http://127.0.0.1:1/proxy/stream/5', {
      onData: (b) => { got.push(b); if (got.length === 2) ctrl.abort() },
      onBreak: () => { throw new Error('no break expected') },
      signal: ctrl.signal, userAgent: 'StalkerWeb-internal/abc', fetchImpl,
    })
    await done
    expect(text(got)).toEqual(['ab', 'cd'])
    expect(Buffer.isBuffer(got[0])).toBe(true)
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1/proxy/stream/5', ua: 'StalkerWeb-internal/abc' }])
  })

  it('follows a live HLS playlist, each segment once and in order', async () => {
    const ctrl = new AbortController()
    const got = []
    const hits = {}
    let polls = 0
    const fetchImpl = async (url) => {
      const u = new URL(url)
      hits[u.pathname] = (hits[u.pathname] ?? 0) + 1
      if (u.pathname === '/proxy/stream/7') return m3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n/proxy/hls?url=media\n#EXT-X-STREAM-INF:BANDWIDTH=400000\n/proxy/hls?url=low\n')
      if (u.pathname === '/proxy/hls') {
        expect(u.searchParams.get('url')).toBe('media')   // the first variant
        const k = polls++
        return m3u8(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${k}`,
          ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:1.0,', `/proxy/hls/seg/s${k + i}.ts`]), ''].join('\n'))
      }
      const m = /^\/proxy\/hls\/seg\/(s\d+)\.ts$/.exec(u.pathname)
      if (m) return ts([m[1]])
      return new Response('nope', { status: 404 })
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { got.push(b); if (got.length === 6) ctrl.abort() },
      onBreak: () => { throw new Error('no break expected') },
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    // From the live edge (the last 3 listed), then each new one as it comes.
    expect(text(got)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    for (const n of [1, 2, 3, 4, 5, 6]) expect(hits[`/proxy/hls/seg/s${n}.ts`]).toBe(1)
    expect(hits['/proxy/stream/7']).toBe(1)
  })

  it('calls onBreak and reconnects when the source ends', async () => {
    const ctrl = new AbortController()
    const events = []
    let calls = 0
    const fetchImpl = async () => {
      calls++
      if (calls === 1) return ts(['first'])   // ends: a restart at the source
      if (calls === 2) throw new Error('ECONNREFUSED')
      return ts(['second'], { hold: true })
    }
    const t0 = Date.now()
    await readSelfStream('http://127.0.0.1:1/proxy/stream/9', {
      onData: (b) => { events.push(b.toString()); if (b.toString() === 'second') ctrl.abort() },
      onBreak: () => events.push('break'),
      signal: ctrl.signal, fetchImpl,
    })
    // One break for the gap, however many tries it took to close it.
    expect(events).toEqual(['first', 'break', 'second'])
    expect(calls).toBe(3)
    // 250 ms after the first break, 500 after the second.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
  })

  it('gives up on a source that keeps refusing: 8 tries in a row with nothing', async () => {
    let calls = 0
    const breaks = []
    const fetchImpl = async () => { calls++; return new Response('Forbidden', { status: 403 }) }
    await expect(readSelfStream('http://127.0.0.1:1/proxy/stream/9', {
      onData: () => {}, onBreak: () => breaks.push(1),
      signal: new AbortController().signal, fetchImpl, backoffMs: () => 0,
    })).rejects.toThrow('the channel stopped answering')
    expect(calls).toBe(8)
  })

  it('gives up after 2 minutes with no bytes, however few the tries', async () => {
    let t = 0
    let calls = 0
    // Each try takes 30 s to fail (a source that never answers).
    const fetchImpl = async () => { calls++; t += 30_000; return new Response('Forbidden', { status: 403 }) }
    const e = await readSelfStream('http://127.0.0.1:1/proxy/stream/9', {
      onData: () => {}, onBreak: () => {}, now: () => t,
      signal: new AbortController().signal, fetchImpl, backoffMs: () => 0,
    }).catch((x) => x)
    expect(e.message).toBe('the channel stopped answering')
    expect(e.gaveUp).toBe(true)
    expect(calls).toBe(4)
  })

  it('does not give up on a source that still sends something now and then', async () => {
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl = async () => (++calls % 7 === 0 ? ts(['x']) : new Response('Forbidden', { status: 403 }))
    await readSelfStream('http://127.0.0.1:1/proxy/stream/9', {
      onData: () => {}, onBreak: () => { if (calls >= 60) ctrl.abort() },
      signal: ctrl.signal, fetchImpl, backoffMs: () => 0,
    })
    expect(calls).toBeGreaterThanOrEqual(60)
  })

  it('stops when aborted', async () => {
    const ctrl = new AbortController()
    let signal
    const fetchImpl = async (url, init) => { signal = init.signal; return ts(['x'], { hold: true }) }
    const breaks = []
    const done = readSelfStream('http://127.0.0.1:1/proxy/stream/3', {
      onData: () => {}, onBreak: () => breaks.push(1), signal: ctrl.signal, fetchImpl,
    })
    let settled = false
    done.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    ctrl.abort()
    await done
    expect(signal.aborted).toBe(true)
    expect(breaks).toEqual([])
    // Aborted before it starts: no request at all.
    let asked = false
    await readSelfStream('http://x/', { onData() {}, onBreak() {}, signal: AbortSignal.abort(), fetchImpl: async () => { asked = true; return ts([]) } })
    expect(asked).toBe(false)
  })

  it('gives each request its own abort signal, so listeners never pile up (Node 18)', async () => {
    const ctrl = new AbortController()
    let most = 0
    let polls = 0
    const signals = new Set()
    const fetchImpl = async (url, init) => {
      // As undici does: a listener on the request's signal, freed only by GC.
      init.signal.addEventListener('abort', () => {})
      signals.add(init.signal)
      most = Math.max(most, getEventListeners(init.signal, 'abort').length)
      const name = segName(url)
      return name ? ts([name]) : media(polls++)
    }
    let got = 0
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: () => { if (++got === 100) ctrl.abort() },
      onBreak: () => { throw new Error('no break expected') },
      signal: ctrl.signal, fetchImpl, pollMs: 0,
    })
    expect(signals.size).toBeGreaterThan(150)
    expect(most).toBeLessThanOrEqual(2)
    expect(getEventListeners(ctrl.signal, 'abort').length).toBeLessThanOrEqual(2)
  })

  it('carries on after a failed segment without replaying what it sent', async () => {
    const ctrl = new AbortController()
    const events = []
    const hits = {}
    let polls = 0
    const fetchImpl = async (url) => {
      const name = segName(url)
      if (!name) return media(polls++)
      hits[name] = (hits[name] ?? 0) + 1
      if (name === 's4' && hits[name] === 1) return new Response('gone', { status: 404 })
      return ts([name])
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { events.push(b.toString()); if (b.toString() === 's6') ctrl.abort() },
      onBreak: () => events.push('break'),
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    expect(events).toEqual(['s1', 's2', 's3', 'break', 's4', 's5', 's6'])
    expect(hits).toEqual({ s1: 1, s2: 1, s3: 1, s4: 2, s5: 1, s6: 1 })
  })

  it('falls back to the live edge when the numbers went back', async () => {
    const ctrl = new AbortController()
    const events = []
    let polls = 0
    let restarted = false
    const fetchImpl = async (url) => {
      const name = segName(url)
      if (name) return ts([name])
      const k = polls++
      return media(k < 2 ? 10 + k : 0)   // 10…13, 11…14, then 0…3
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { events.push(b.toString()); if (restarted && b.toString() === 's3') ctrl.abort() },
      onBreak: () => { restarted = true; events.push('break') },
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    // One break: the reconnect that found the numbers back isn't a second gap.
    expect(events).toEqual(['s11', 's12', 's13', 's14', 'break', 's1', 's2', 's3'])
  })

  it('calls onBreak for a gap in the numbers, and for a discontinuity at the source', async () => {
    const ctrl = new AbortController()
    const events = []
    let polls = 0
    const fetchImpl = async (url) => {
      const name = segName(url)
      if (name) return ts([name])
      const k = polls++
      if (k === 0) return media(0)                                  // s1 s2 s3 from the edge
      if (k === 1) return media(5)                                  // s4 never listed: a gap
      return m3u8(['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:8',
        '#EXTINF:1.0,', '/seg/s8.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:1.0,', '/seg/s9.ts', ''].join('\n'))
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { events.push(b.toString()); if (b.toString() === 's9') ctrl.abort() },
      onBreak: () => events.push('break'),
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    expect(events).toEqual(['s1', 's2', 's3', 'break', 's5', 's6', 's7', 's8', 'break', 's9'])
  })

  it('follows a live playlist without #EXT-X-MEDIA-SEQUENCE by its URIs', async () => {
    const ctrl = new AbortController()
    const got = []
    const hits = {}
    let polls = 0
    // A sliding window of 4, never numbered.
    const fetchImpl = async (url) => {
      const name = segName(url)
      if (name) { hits[name] = (hits[name] ?? 0) + 1; return ts([name]) }
      const k = polls++
      return m3u8(['#EXTM3U', '#EXT-X-TARGETDURATION:1', ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:1.0,', `/seg/s${k + i}.ts`]), ''].join('\n'))
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { got.push(b.toString()); if (got.length === 6) ctrl.abort() },
      onBreak: () => { throw new Error('no break expected') },
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    expect(got).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    for (const n of [1, 2, 3, 4, 5, 6]) expect(hits[`s${n}`]).toBe(1)
  })

  it('tries a segment that failed once again after it came through and its number came round again', async () => {
    const ctrl = new AbortController()
    const hits = {}
    let polls = 0
    const list = (tag, k) => m3u8(['#EXTM3U', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${k}`,
      ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:1.0,', `/seg/${tag}${k + i}.ts`]), ''].join('\n'))
    const fetchImpl = async (url) => {
      const name = /\/seg\/(\w+)\.ts$/.exec(new URL(url).pathname)?.[1]
      if (name) {
        hits[name] = (hits[name] ?? 0) + 1
        if ((name === 'a4' || name === 'b4') && hits[name] === 1) return new Response('gone', { status: 404 })
        if (name === 'b4') ctrl.abort()
        return ts([name])
      }
      const k = polls++
      if (k > 12) ctrl.abort()
      // a1…a4 (a4 fails once, then comes), then the source restarts at 0: b0…b3, then b1…b4.
      return k < 2 ? list('a', 1) : k < 4 ? list('b', 0) : list('b', 1)
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: () => {}, onBreak: () => {}, signal: ctrl.signal, fetchImpl, pollMs: 5, backoffMs: () => 0,
    })
    expect(hits.a4).toBe(2)
    expect(hits.b4).toBe(2)   // failed once: tried again, not skipped for a4's old mark
  })

  it('breaks before fetching again a segment whose body failed midway', async () => {
    const ctrl = new AbortController()
    const events = []
    let polls = 0
    let s2 = 0
    const fetchImpl = async (url) => {
      const name = segName(url)
      if (!name) return media(polls++ ? 1 : 0)
      if (name === 's2' && ++s2 === 1) {
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(Buffer.from('half'))) },
          pull(c) { c.error(new Error('ECONNRESET')) },
        }), { headers: { 'Content-Type': 'video/mp2t' } })
      }
      return ts([name])
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { events.push(b.toString()); if (b.toString() === 's3') ctrl.abort() },
      onBreak: () => events.push('break'),
      signal: ctrl.signal, fetchImpl, pollMs: 10, backoffMs: () => 0,
    })
    // The TV gets the whole segment again, after a discontinuity, not glued to its first half.
    expect(events).toEqual(['s1', 'half', 'break', 's2', 's3'])
  })

  it('opens the source again when it goes quiet (the stall watchdog)', async () => {
    const ctrl = new AbortController()
    const events = []
    let calls = 0
    const fetchImpl = async () => (++calls === 1 ? ts(['x'], { hold: true }) : ts(['y'], { hold: true }))
    await readSelfStream('http://127.0.0.1:1/proxy/stream/9', {
      onData: (b) => { events.push(b.toString()); if (b.toString() === 'y') ctrl.abort() },
      onBreak: () => events.push('break'),
      signal: ctrl.signal, fetchImpl, stallMs: 50, backoffMs: () => 0,
    })
    expect(events).toEqual(['x', 'break', 'y'])
  })

  it('reads a body without a Content-Type as a playlist when it starts with #EXTM3U', async () => {
    const ctrl = new AbortController()
    const got = []
    let polls = 0
    const fetchImpl = async (url) => {
      const name = segName(url)
      if (name) return ts([name])
      const k = polls++
      const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${k}`,
        ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:1.0,', `/seg/s${k + i}.ts`]), ''].join('\n')
      return new Response(body(['  ' + text.slice(0, 5), text.slice(5)]))   // no headers; split, with a little space first
    }
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { got.push(b.toString()); if (got.length === 4) ctrl.abort() },
      onBreak: () => { throw new Error('no break expected') },
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    expect(got).toEqual(['s1', 's2', 's3', 's4'])
  })

  for (const [kind, tag, reason] of [
    ['an encrypted', '#EXT-X-KEY:METHOD=AES-128,URI="/key"', /encrypt/i],
    ['a SAMPLE-AES', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/key"', /encrypt/i],
    ['an fMP4', '#EXT-X-MAP:URI="/init.mp4"', /fmp4/i],
  ]) {
    it(`reports ${kind} HLS channel instead of piping its bytes`, async () => {
      const reasons = []
      let segs = 0
      const fetchImpl = async (url) => {
        if (segName(url)) { segs++; return ts(['x']) }
        return media(0, [tag])
      }
      await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
        onData: () => { throw new Error('no bytes expected') },
        onBreak: () => { throw new Error('no break expected') },
        onUnsupported: (why) => reasons.push(why),
        signal: new AbortController().signal, fetchImpl, pollMs: 10,
      })
      expect(reasons).toHaveLength(1)
      expect(reasons[0]).toMatch(reason)
      expect(segs).toBe(0)
    })
  }

  it('reads a playlist whose key is METHOD=NONE as any other', async () => {
    const ctrl = new AbortController()
    const got = []
    const fetchImpl = async (url) => (segName(url) ? ts([segName(url)]) : media(0, ['#EXT-X-KEY:METHOD=NONE']))
    await readSelfStream('http://127.0.0.1:1/proxy/stream/7', {
      onData: (b) => { got.push(b.toString()); if (got.length === 3) ctrl.abort() },
      onBreak: () => {}, onUnsupported: () => { throw new Error('supported') },
      signal: ctrl.signal, fetchImpl, pollMs: 10,
    })
    expect(got).toEqual(['s1', 's2', 's3'])
  })
})
