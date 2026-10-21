// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const toast = vi.hoisted(() => vi.fn())
vi.mock('./toast', () => ({ showToast: toast }))

let root, host, api
function Player(props) {
  const videoRef = useRef(null)
  api = props.useCasting({ videoRef, ...props.opts })
  return <video ref={videoRef} />
}
async function mount(opts) {
  const { useCasting } = await import('./useCasting')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<Player useCasting={useCasting} opts={opts} />))
  return host.querySelector('video')
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.resetModules() })

const link = { url: 'https://tv.example.com/k/t/proxy/cast/live/5/index.m3u8', contentType: 'application/x-mpegURL', live: true, reachable: true }

describe('AirPlay', () => {
  beforeEach(() => { window.WebKitPlaybackTargetAvailabilityEvent = function () {} })
  afterEach(() => { delete window.WebKitPlaybackTargetAvailabilityEvent })

  it('shows once an Apple TV is around, and puts the plain link in the video in the tap itself', async () => {
    const toNative = vi.fn()
    const video = await mount({ mediaKey: '5', getLink: async () => link, getMeta: () => ({}), toNative })
    expect(api.airplay.available).toBe(false)
    const e = new Event('webkitplaybacktargetavailabilitychanged')
    e.availability = 'available'
    await act(async () => video.dispatchEvent(e))
    await flush()
    expect(api.airplay.available).toBe(true)
    video.webkitShowPlaybackTargetPicker = vi.fn()
    act(() => api.airplay.start())
    expect(toNative).toHaveBeenCalledWith(link.url)
    expect(video.webkitShowPlaybackTargetPicker).toHaveBeenCalled()
  })

  it("says why it can't, rather than \"try again\" forever", async () => {
    const video = await mount({ mediaKey: '5', getLink: async () => ({ ...link, reachable: false }), getMeta: () => ({}), toNative: vi.fn() })
    const e = new Event('webkitplaybacktargetavailabilitychanged')
    e.availability = 'available'
    await act(async () => video.dispatchEvent(e))
    await flush()
    toast.mockClear()
    act(() => api.airplay.start())
    expect(toast.mock.calls[0][0]).toMatch(/localhost/)
  })

  it('waits for the page before fetching its link (ready)', async () => {
    const getLink = vi.fn(async () => link)
    const video = await mount({ mediaKey: '5', ready: false, getLink, getMeta: () => ({}), toNative: vi.fn() })
    const e = new Event('webkitplaybacktargetavailabilitychanged')
    e.availability = 'available'
    await act(async () => video.dispatchEvent(e))
    await flush()
    expect(getLink).not.toHaveBeenCalled()
  })

  it('says it plays on the Apple TV while it does', async () => {
    const video = await mount({ mediaKey: '5', getLink: async () => link, getMeta: () => ({}), toNative: vi.fn() })
    video.webkitCurrentPlaybackTargetIsWireless = true
    await act(async () => video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged')))
    expect(api.mode).toBe('airplay')
  })
})

describe('Chromecast', () => {
  let state, listeners, session, ctx
  beforeEach(() => {
    state = 'NOT_CONNECTED'
    listeners = []
    session = { loadMedia: vi.fn(async () => {}), getCastDevice: () => ({ friendlyName: 'Living Room' }) }
    ctx = {
      setOptions: vi.fn(),
      getCastState: () => state,
      getCurrentSession: () => (state === 'CONNECTED' ? session : null),
      addEventListener: (_t, fn) => listeners.push(fn),
      removeEventListener: () => {},
      requestSession: vi.fn(async () => {}),
      endCurrentSession: vi.fn(),
    }
    window.chrome = {
      cast: {
        AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
        Image: function (url) { this.url = url },
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
          StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
          MediaInfo: function (url, type) { this.contentId = url; this.contentType = type },
          GenericMediaMetadata: function () {},
          LoadRequest: function (info) { this.media = info },
        },
      },
    }
    window.cast = {
      framework: {
        CastContext: { getInstance: () => ctx },
        CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE', NOT_CONNECTED: 'NOT_CONNECTED', CONNECTED: 'CONNECTED' },
        CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged' },
        RemotePlayer: function () { this.currentTime = 0; this.duration = 0; this.isPaused = true },
        RemotePlayerController: function () { this.addEventListener = () => {}; this.removeEventListener = () => {}; this.playOrPause = vi.fn(); this.seek = vi.fn() },
        RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
      },
    }
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  })
  afterEach(() => { delete window.chrome; delete window.cast })

  const connect = async (to) => { state = to; await act(async () => listeners.forEach((fn) => fn())) ; await flush() }
  // Cast pressed on this page: the picker, then connected.
  const castFromHere = async () => {
    ctx.requestSession = vi.fn(async () => { state = 'CONNECTED' })
    await act(async () => api.chromecast.start())
    await connect('CONNECTED')
  }

  it('hands the stream to the TV, from where the page is, and takes it back after', async () => {
    const onTvStart = vi.fn(), onTvEnd = vi.fn()
    await mount({ mediaKey: '7', getLink: async () => ({ ...link, live: false, contentType: 'video/mp4' }), getMeta: () => ({ title: 'Heat', startSecs: 61 }), onTvStart, onTvEnd, toNative: vi.fn() })
    await flush()
    expect(api.chromecast.available).toBe(true)
    await castFromHere()
    expect(onTvStart).toHaveBeenCalled()
    expect(api.mode).toBe('chromecast')
    expect(api.device).toBe('Living Room')
    const req = session.loadMedia.mock.calls[0][0]
    expect(req.media.contentId).toBe(link.url)
    expect(req.media.streamType).toBe('BUFFERED')
    expect(req.currentTime).toBe(61)
    await connect('NOT_CONNECTED')
    expect(onTvEnd).toHaveBeenCalled()
    expect(api.mode).toBe(null)
  })

  it("leaves a session another tab started alone: joined, it doesn't take the TV", async () => {
    const onTvStart = vi.fn()
    await mount({ mediaKey: '7', getLink: async () => link, getMeta: () => ({}), onTvStart, onTvEnd: vi.fn(), toNative: vi.fn() })
    await flush()
    await connect('CONNECTED')
    expect(onTvStart).not.toHaveBeenCalled()
    expect(session.loadMedia).not.toHaveBeenCalled()
    expect(api.mode).toBe(null)
  })

  it('ends the cast when the TV gets nothing to play, so the page plays it again', async () => {
    const onTvEnd = vi.fn()
    await mount({ mediaKey: '7', getLink: async () => ({ ...link, reachable: false }), getMeta: () => ({}), onTvStart: vi.fn(), onTvEnd, toNative: vi.fn() })
    await flush()
    await castFromHere()
    expect(ctx.endCurrentSession).toHaveBeenCalled()
    expect(onTvEnd).toHaveBeenCalled()
    expect(api.mode).toBe(null)
  })

  async function mountKeyed(opts, key) {
    const { useCasting } = await import('./useCasting')
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    const render = (k) => act(async () => root.render(<Player useCasting={useCasting} opts={{ ...opts, mediaKey: k }} />))
    await render(key)
    await flush()
    return render
  }

  it("sends the next channel to the TV — that channel's link — and lets the server go of the last", async () => {
    const release = vi.fn()
    let current = '5'
    const getLink = vi.fn(async () => ({ ...link, url: `https://tv/k/t/proxy/cast/live/${current}/index.m3u8` }))
    const render = await mountKeyed({ getLink, getMeta: () => ({}), onTvStart: vi.fn(), onTvEnd: vi.fn(), release, toNative: vi.fn() }, '5')
    await castFromHere()
    expect(session.loadMedia).toHaveBeenCalledTimes(1)
    current = '6'
    await render('6')
    await flush()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
    expect(session.loadMedia.mock.calls[1][0].media.contentId).toContain('/live/6/')
    expect(release).toHaveBeenCalledWith('5')
    await connect('NOT_CONNECTED')
    expect(release).toHaveBeenLastCalledWith('6')
  })

  it('plays the last one asked for, however the links come back', async () => {
    let slow
    const getLink = vi.fn((k) => k)
    const render = await mountKeyed({
      getLink: () => getLink(current()),
      getMeta: () => ({}), onTvStart: vi.fn(), onTvEnd: vi.fn(), toNative: vi.fn(),
    }, 'e1')
    let key = 'e1'
    function current() {
      if (key === 'e2') return new Promise((r) => { slow = () => r({ ...link, url: 'https://tv/e2' }) })
      return Promise.resolve({ ...link, url: `https://tv/${key}` })
    }
    await castFromHere()
    key = 'e2'; await render('e2')
    key = 'e3'; await render('e3')
    await flush()
    slow()
    await flush()
    const urls = session.loadMedia.mock.calls.map((c) => c[0].media.contentId)
    expect(urls.at(-1)).toBe('https://tv/e3')
    expect(urls).not.toContain('https://tv/e2')
  })
})
