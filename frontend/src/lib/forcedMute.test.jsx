// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { listenForSound, useSoundOnFirstGesture } from './forcedMute'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const cleanups = []
afterEach(() => { while (cleanups.length) cleanups.pop()(); document.body.innerHTML = '' })
const later = (fn) => { cleanups.push(fn); return fn }

const key = (code, k, more = {}) => new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true, ...more })
const SPACE = () => key('Space', ' ')

// ── The player, as the pages use it: the real rules for the picture and the mute button ──

let setMuted
function Player({ blocked, isMuteKey, onPicture }) {
  const videoRef = useRef(null)
  useSoundOnFirstGesture(blocked, videoRef, setMuted, { isMuteKey, onPicture })
  return (
    <div id="area">
      <video ref={videoRef} muted />
      <div><button id="mute" data-mute-button><span id="icon">x</span></button><button id="info">Info</button><input id="search" /></div>
    </div>
  )
}
function mount(props = {}) {
  setMuted = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<Player blocked {...props} />))
  later(() => act(() => root.unmount()))
  const $ = (s) => document.querySelector(s)
  const video = $('video')
  video.muted = true
  return { video, $, playing: (on = true) => Object.defineProperty(video, 'paused', { value: !on, configurable: true }) }
}
/** A handler of the page's own, as a player's: sees what the listener lets through. */
function pageHandler(target, type) {
  const fn = vi.fn()
  target.addEventListener(type, fn)
  later(() => target.removeEventListener(type, fn))
  return fn
}

describe('useSoundOnFirstGesture', () => {
  it('a first click on the playing picture brings the sound back — on the video itself — without pausing it', () => {
    const { video, $, playing } = mount()
    playing()
    const paused = pageHandler($('#area'), 'click')
    act(() => video.click())
    expect(video.muted).toBe(false)
    expect(setMuted).toHaveBeenCalledWith(false)
    expect(paused).not.toHaveBeenCalled()
    act(() => video.click())   // later clicks are the picture's again
    expect(paused).toHaveBeenCalledTimes(1)
    expect(setMuted).toHaveBeenCalledTimes(1)
  })

  it('a first click on a paused picture brings the sound back and plays it too', () => {
    const { video, $ } = mount()   // paused: the browser wouldn't even start it muted
    const played = pageHandler($('#area'), 'click')
    act(() => video.click())
    expect(video.muted).toBe(false)
    expect(played).toHaveBeenCalledTimes(1)
  })

  it("Space on the page (it holds the video) isn't also a pause, and the player's controls come up", () => {
    const onPicture = vi.fn()
    const { video, playing } = mount({ onPicture })
    playing()
    const toggled = pageHandler(window, 'keydown')
    act(() => document.body.dispatchEvent(SPACE()))
    expect(video.muted).toBe(false)
    expect(toggled).not.toHaveBeenCalled()
    expect(onPicture).toHaveBeenCalledTimes(1)
  })

  it('on a control, or typed in a box, brings the sound back and leaves the key or click to it', () => {
    const { video, $, playing } = mount()
    playing()
    const pressed = pageHandler($('#info'), 'click')
    act(() => $('#info').click())
    expect(video.muted).toBe(false)
    expect(pressed).toHaveBeenCalledTimes(1)
    cleanups.pop()(); cleanups.pop()()   // the first player gone, and its handler
    document.body.innerHTML = ''

    const m = mount()
    m.playing()
    const e = SPACE()
    act(() => m.$('#search').dispatchEvent(e))
    expect(m.video.muted).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  it("leaves the mute button's click, Enter or Space to it — it unmutes by itself", () => {
    for (const press of [(b) => b.click(), (b) => b.dispatchEvent(key('Enter', 'Enter')), (b) => b.dispatchEvent(SPACE())]) {
      const { video, $ } = mount()
      act(() => press($('#icon')))   // on what's inside it too
      act(() => $('#info').click())   // and stopped: the button had it
      expect(video.muted).toBe(true)
      expect(setMuted).not.toHaveBeenCalled()
      cleanups.pop()()
    }
  })

  it('leaves the mute key to the player', () => {
    const { video, $ } = mount({ isMuteKey: (e) => e.code === 'KeyM' })
    act(() => document.body.dispatchEvent(key('KeyM', 'm')))
    act(() => $('#info').click())
    expect(video.muted).toBe(true)
  })

  it('stops listening once not blocked', () => {
    setMuted = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<Player blocked />))
    act(() => root.render(<Player blocked={false} />))
    later(() => act(() => root.unmount()))
    act(() => document.querySelector('#info').click())
    expect(setMuted).not.toHaveBeenCalled()
  })
})

// ── Only a gesture the browser counts ──

describe('listenForSound', () => {
  const listen = (more) => {
    const onSound = vi.fn()
    later(listenForSound({ onSound, ...more }))
    return onSound
  }

  it("without navigator.userActivation, leaves out the keys no browser counts (Escape, a modifier alone, a shortcut)", () => {
    const onSound = listen({ activation: () => undefined })
    for (const [code, k, more] of [['Escape', 'Escape'], ['ShiftLeft', 'Shift'], ['CapsLock', 'CapsLock'], ['NumLock', 'NumLock'], ['KeyR', 'r', { ctrlKey: true }]]) {
      document.body.dispatchEvent(key(code, k, more))
    }
    expect(onSound).not.toHaveBeenCalled()
    document.body.dispatchEvent(key('KeyK', 'k'))
    expect(onSound).toHaveBeenCalledTimes(1)
  })

  it('with it, the browser decides', () => {
    const ua = { isActive: false }
    const onSound = listen({ activation: () => ua })
    document.body.dispatchEvent(key('KeyK', 'k'))
    document.body.click()
    expect(onSound).not.toHaveBeenCalled()
    ua.isActive = true
    document.body.dispatchEvent(key('ShiftLeft', 'Shift'))   // a browser that counts it
    expect(onSound).toHaveBeenCalledTimes(1)
  })

  it('stops listening when stopped', () => {
    const onSound = vi.fn()
    listenForSound({ onSound, activation: () => undefined })()
    document.body.click()
    expect(onSound).not.toHaveBeenCalled()
  })
})
