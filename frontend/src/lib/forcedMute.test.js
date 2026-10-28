// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { listenForSound } from './forcedMute'

let stop
afterEach(() => { stop?.(); document.body.innerHTML = '' })

function page() {
  document.body.innerHTML = '<div id="pic"><video></video></div><button id="mute" data-mute-button>Mute</button><button id="other">Info</button>'
  return { pic: document.querySelector('#pic'), mute: document.querySelector('#mute'), other: document.querySelector('#other') }
}
const opts = (onSound) => ({
  onSound,
  isPicture: (t) => !!t.closest('#pic'),
  isMuteButton: (t) => !!t.closest('[data-mute-button]'),
})

describe('listenForSound', () => {
  it('brings the sound back on the first click on the picture, without the click pausing it', () => {
    const { pic } = page()
    const onSound = vi.fn()
    const paused = vi.fn()
    pic.addEventListener('click', paused)
    stop = listenForSound(opts(onSound))
    pic.click()
    expect(onSound).toHaveBeenCalledTimes(1)
    expect(paused).not.toHaveBeenCalled()
    pic.click()   // later clicks are the picture's again
    expect(paused).toHaveBeenCalledTimes(1)
    expect(onSound).toHaveBeenCalledTimes(1)
  })

  it('on a control, brings the sound back and lets the control work', () => {
    const { other } = page()
    const onSound = vi.fn()
    const pressed = vi.fn()
    other.addEventListener('click', pressed)
    stop = listenForSound(opts(onSound))
    other.click()
    expect(onSound).toHaveBeenCalledTimes(1)
    expect(pressed).toHaveBeenCalledTimes(1)
  })

  it("leaves the mute button's click to it, which unmutes by itself", () => {
    const { mute } = page()
    const onSound = vi.fn()
    stop = listenForSound(opts(onSound))
    mute.click()
    expect(onSound).not.toHaveBeenCalled()
  })

  it('brings the sound back on the first key, Space not also pausing it', () => {
    page()
    const onSound = vi.fn()
    const toggled = vi.fn()
    window.addEventListener('keydown', toggled)
    stop = listenForSound(opts(onSound))
    const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    document.querySelector('video').dispatchEvent(e)
    expect(onSound).toHaveBeenCalledTimes(1)
    expect(toggled).not.toHaveBeenCalled()
    window.removeEventListener('keydown', toggled)
  })

  it('brings the sound back on a first Space on a button without taking the key from it', () => {
    const { other } = page()
    const onSound = vi.fn()
    stop = listenForSound(opts(onSound))
    const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    other.dispatchEvent(e)
    expect(onSound).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(false)
  })

  it('leaves the mute key to the player, and ignores shortcuts with a modifier', () => {
    page()
    const onSound = vi.fn()
    stop = listenForSound({ ...opts(onSound), isMuteKey: (e) => e.code === 'KeyM' })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', ctrlKey: true, bubbles: true }))
    expect(onSound).not.toHaveBeenCalled()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', bubbles: true }))
    expect(onSound).not.toHaveBeenCalled()   // stopped: the player's M unmuted it
  })

  it('stops listening when stopped', () => {
    const { other } = page()
    const onSound = vi.fn()
    listenForSound(opts(onSound))()
    other.click()
    expect(onSound).not.toHaveBeenCalled()
  })
})
