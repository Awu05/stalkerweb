import { describe, it, expect, vi, afterEach } from 'vitest'
import { reportPlayerError, mediaErrorText, hlsErrorText } from './playerReport'

afterEach(() => vi.unstubAllGlobals())

describe('the words a report carries', () => {
  it("says hls.js's fatal error: its kind, details, HTTP code and message", () => {
    expect(hlsErrorText({ type: 'mediaError', details: 'bufferAppendError', error: { message: 'codec hvc1 not supported' }, mimeType: 'video/mp4;codecs="hvc1.2.4.L153"' }))
      .toEqual({ kind: 'mediaError', detail: 'bufferAppendError: codec hvc1 not supported: video/mp4;codecs="hvc1.2.4.L153"' })
    expect(hlsErrorText({ type: 'networkError', details: 'fragLoadError', response: { code: 502 } }).detail).toBe('fragLoadError: HTTP 502')
  })

  it("says the <video>'s own error, or nothing without one", () => {
    expect(mediaErrorText({ error: { code: 3, message: 'PIPELINE_ERROR_DECODE' } })).toBe('MediaError 3 (decode): PIPELINE_ERROR_DECODE')
    expect(mediaErrorText({ error: { code: 4 } })).toBe('MediaError 4 (format not supported)')
    expect(mediaErrorText({ error: null })).toBeNull()
  })
})

describe('reportPlayerError', () => {
  it('posts the report, and the same one again within 10 s only once', () => {
    const fetch = vi.fn(() => Promise.resolve({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const r = { channelId: '1896', engine: 'hls.js', kind: 'mediaError', detail: 'x' }
    reportPlayerError(r)
    reportPlayerError(r)
    reportPlayerError({ ...r, detail: 'y' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('/api/stream/report')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject(r)
  })

  it('never throws, whatever the network does', () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    expect(() => reportPlayerError({ channelId: '2', engine: 'hls.js', kind: 'k' })).not.toThrow()
  })
})
