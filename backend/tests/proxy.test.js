import { describe, it, expect } from 'vitest'
import { helpers } from '../routes/proxy.js'

const { encodeProxyUrl, decodeProxyUrl, rewriteM3u8, isPlaylistUrl, resolveUrl, isM3u8Body, signProxyUrl } = helpers

describe('encodeProxyUrl / decodeProxyUrl', () => {
  it('round-trips a URL', () => {
    const url = 'https://example.com/stream/path/file.ts?token=abc'
    expect(decodeProxyUrl(encodeProxyUrl(url))).toBe(url)
  })

  it('handles special characters', () => {
    const url = 'https://ex.com/a?q=foo bar&baz=1+2'
    expect(decodeProxyUrl(encodeProxyUrl(url))).toBe(url)
  })
})

describe('isPlaylistUrl', () => {
  it('detects .m3u8 URLs', () => {
    expect(isPlaylistUrl('https://example.com/playlist.m3u8')).toBe(true)
    expect(isPlaylistUrl('https://example.com/stream.m3u')).toBe(true)
    expect(isPlaylistUrl('https://example.com/playlist.m3u8?token=abc')).toBe(true)
    expect(isPlaylistUrl('https://example.com/segment.ts')).toBe(false)
    expect(isPlaylistUrl('https://example.com/segment.ts?token=abc')).toBe(false)
    expect(isPlaylistUrl('https://example.com/file.aac')).toBe(false)
  })
})

describe('resolveUrl', () => {
  it('returns absolute URLs as-is', () => {
    expect(resolveUrl('https://example.com/file.ts', 'https://base.com/play.m3u8'))
      .toBe('https://example.com/file.ts')
  })

  it('resolves relative URLs', () => {
    expect(resolveUrl('segment.ts', 'https://base.com/hls/play.m3u8'))
      .toBe('https://base.com/hls/segment.ts')
  })

  it('resolves dot-relative URLs', () => {
    expect(resolveUrl('../segment.ts', 'https://base.com/hls/a/play.m3u8'))
      .toBe('https://base.com/hls/segment.ts')
  })
})

describe('isM3u8Body', () => {
  it('detects m3u8 content', () => {
    expect(isM3u8Body('#EXTM3U\n#EXT-X-VERSION:3\nsegment.ts')).toBe(true)
    expect(isM3u8Body('#EXT-X-TARGETDURATION:10')).toBe(true)
    expect(isM3u8Body('not a playlist')).toBe(false)
    expect(isM3u8Body('')).toBe(false)
  })
})

describe('rewriteM3u8', () => {
  const ORIGIN = 'http://proxy:8983'
  const PLAYLIST_URL = 'https://portal.test/hls/playlist.m3u8'

  it('rewrites segment URLs with .ts suffix', () => {
    const input = '#EXTM3U\n#EXTINF:10,\nsegment1.ts\nsegment2.ts\n'
    const result = rewriteM3u8(input, PLAYLIST_URL, ORIGIN)
    const lines = result.split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[1]).toBe('#EXTINF:10,')
    expect(lines[2]).toMatch(/^http:\/\/proxy:8983\/proxy\/hls\/seg\/.+\.ts$/)
    expect(lines[3]).toMatch(/^http:\/\/proxy:8983\/proxy\/hls\/seg\/.+\.ts$/)
  })

  it('rewrites playlist URLs with query-string format', () => {
    const input = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nsub.m3u8\n'
    const result = rewriteM3u8(input, PLAYLIST_URL, ORIGIN)
    const lines = result.split('\n')
    expect(lines[2]).toMatch(/^http:\/\/proxy:8983\/proxy\/hls\?url=.+$/)
    expect(lines[2]).not.toContain('.ts')
  })

  it('rewrites URI="" attributes in tags', () => {
    const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://portal.test/key.bin"\nseg.ts\n'
    const result = rewriteM3u8(input, PLAYLIST_URL, ORIGIN)
    expect(result).toContain('URI="http://proxy:8983/proxy/hls?url=')
    expect(result).toContain('/proxy/hls/seg/')
    expect(result).not.toContain('https://portal.test')  // all URLs rewritten
  })

  it('preserves non-URL lines', () => {
    const input = '#EXTM3U\n#EXT-X-VERSION:3\n# comment line\nseg.ts\n'
    const result = rewriteM3u8(input, PLAYLIST_URL, ORIGIN)
    expect(result).toContain('#EXT-X-VERSION:3')
    expect(result).toContain('# comment line')
  })

  it('omits signatures when no secret is given', () => {
    const input = '#EXTM3U\n#EXTINF:10,\nseg.ts\nsub.m3u8\n'
    const result = rewriteM3u8(input, PLAYLIST_URL, ORIGIN)
    expect(result).not.toContain('sig=')
  })

  it('appends a valid HMAC signature for segment and playlist URLs when a secret is given', () => {
    const secret = 'test-secret'
    const input = '#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsub.m3u8\n'
    const lines = rewriteM3u8(input, PLAYLIST_URL, ORIGIN, secret).split('\n')

    const segLine = lines.find(l => l.includes('/proxy/hls/seg/'))
    const subLine = lines.find(l => l.includes('/proxy/hls?url='))

    // segment keeps the .ts path suffix with sig in the query
    expect(segLine).toMatch(/\/proxy\/hls\/seg\/.+\.ts\?sig=.+$/)
    // signature must match what the server will recompute from the decoded URL
    const segAbs = resolveUrl('seg.ts', PLAYLIST_URL)
    expect(segLine).toContain(`sig=${signProxyUrl(segAbs, secret)}`)

    const subAbs = resolveUrl('sub.m3u8', PLAYLIST_URL)
    expect(subLine).toContain(`&sig=${signProxyUrl(subAbs, secret)}`)
  })
})

describe("delivery, for the player's Stats", () => {
  it("names a movie file's container", () => {
    expect(helpers.containerLabel('video/mp4')).toBe('MP4')
    expect(helpers.containerLabel('video/x-matroska; charset=binary')).toBe('MKV')
    expect(helpers.containerLabel('application/octet-stream')).toBe('')
    expect(helpers.containerLabel(undefined)).toBe('')
  })

  it("says what FFmpeg re-encodes, or that it only repackages", async () => {
    const { deliveryOf } = await import('../stalker/FfmpegService.js')
    expect(deliveryOf(['-c:v', 'copy', '-c:a', 'copy'])).toEqual({ mode: 'repackaged', detail: '' })
    expect(deliveryOf(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'])).toEqual({ mode: 'converted', detail: 'audio → AAC' })
    expect(deliveryOf(['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'])).toEqual({ mode: 'converted', detail: 'video → H.264, audio → AAC' })
  })
})
