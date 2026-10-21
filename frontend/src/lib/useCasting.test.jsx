// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./toast', () => ({ showToast: vi.fn() }))

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

  it('hands the stream to the TV, from where the page is, and takes it back after', async () => {
    const onTvStart = vi.fn(), onTvEnd = vi.fn()
    await mount({ mediaKey: '7', getLink: async () => ({ ...link, live: false, contentType: 'video/mp4' }), getMeta: () => ({ title: 'Heat', startSecs: 61 }), onTvStart, onTvEnd, toNative: vi.fn() })
    await flush()
    expect(api.chromecast.available).toBe(true)
    await connect('CONNECTED')
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

  it('sends the next channel to the TV when it changes', async () => {
    const getLink = vi.fn(async () => link)
    const { useCasting } = await import('./useCasting')
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    const opts = { getLink, getMeta: () => ({}), onTvStart: vi.fn(), onTvEnd: vi.fn(), toNative: vi.fn() }
    await act(async () => root.render(<Player useCasting={useCasting} opts={{ ...opts, mediaKey: '5' }} />))
    await flush()
    await connect('CONNECTED')
    expect(session.loadMedia).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Player useCasting={useCasting} opts={{ ...opts, mediaKey: '6' }} />))
    await flush()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
  })
})
