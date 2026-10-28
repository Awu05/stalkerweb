import { describe, it, expect } from 'vitest'
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
    expect(events).toEqual(['first', 'break', 'break', 'second'])
    expect(calls).toBe(3)
    // 250 ms after the first break, 500 after the second.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
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
})
