import { describe, it, expect } from 'vitest'
import { chromecastSupported, airplaySupported, castRequestOf, resumeAfterCast } from './cast'

const win = (o = {}) => ({ chrome: {}, isSecureContext: true, navigator: { userAgent: 'Mozilla/5.0 Chrome/140' }, ...o })

describe('which casting a browser can do', () => {
  it('Chromecast: Chrome or Edge on a secure page, not on iOS', () => {
    expect(chromecastSupported(win())).toBe(true)
    expect(chromecastSupported(win({ isSecureContext: false }))).toBe(false)   // http:// on the LAN
    expect(chromecastSupported(win({ chrome: undefined }))).toBe(false)        // Firefox, Safari
    expect(chromecastSupported(win({ navigator: { userAgent: 'Mozilla/5.0 (iPhone) CriOS/140' } }))).toBe(false)
    expect(chromecastSupported(undefined)).toBe(false)
  })

  it('AirPlay: Safari', () => {
    expect(airplaySupported({ WebKitPlaybackTargetAvailabilityEvent: function () {} })).toBe(true)
    expect(airplaySupported(win())).toBe(false)
  })
})

describe('castRequestOf', () => {
  const movie = { url: 'https://tv.example.com/k/t/proxy/vod/stream.mp4?videoId=1', contentType: 'video/mp4', live: false, reachable: true }
  const channel = { url: 'https://tv.example.com/k/t/proxy/cast/live/5/index.m3u8', contentType: 'application/x-mpegURL', live: true, reachable: true }

  it('starts a movie where the page was, live from now', () => {
    expect(castRequestOf(movie, { title: 'Heat', startSecs: 61.5 })).toMatchObject({ url: movie.url, live: false, startSecs: 61.5, title: 'Heat' })
    expect(castRequestOf(channel, { title: 'News', startSecs: 61.5 })).toMatchObject({ live: true, startSecs: 0 })
  })

  it('refuses a link only this machine can open', () => {
    expect(() => castRequestOf({ ...movie, reachable: false })).toThrow(/localhost/)
    expect(() => castRequestOf(null)).toThrow()
  })

  it('sends a picture only when the TV can fetch it', () => {
    expect(castRequestOf(movie, { image: 'http://portal/img/1.jpg' }).image).toBe('http://portal/img/1.jpg')
    expect(castRequestOf(movie, { image: '/api/logos/1.png' }).image).toBe('')
    expect(castRequestOf(movie, { image: 'http://localhost:8983/x.jpg' }).image).toBe('')
  })
})

describe('resumeAfterCast', () => {
  it('picks up where the TV got to, unless at the end or not started', () => {
    expect(resumeAfterCast(1200, 6000)).toBe(1200)
    expect(resumeAfterCast(5800, 6000)).toBeNull()
    expect(resumeAfterCast(0, 6000)).toBeNull()
    expect(resumeAfterCast(30, 0)).toBe(30)
  })
})
