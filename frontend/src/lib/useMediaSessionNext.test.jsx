// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useMediaSessionNext } from './useMediaSessionNext'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root, handlers, setActionHandler
function Probe({ on, onNext }) {
  useMediaSessionNext(on, onNext)
  return null
}
const render = (on, onNext) => act(() => root.render(<Probe on={on} onNext={onNext} />))
const withSession = (impl) => Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: { setActionHandler: impl } })

beforeEach(() => {
  handlers = {}
  setActionHandler = vi.fn((action, fn) => { handlers[action] = fn })
  withSession(setActionHandler)
  root = createRoot(document.createElement('div'))
})
afterEach(() => { act(() => root.unmount()); delete navigator.mediaSession })

describe('useMediaSessionNext', () => {
  it("puts a next-track button on the browser's player that plays the next episode", () => {
    const onNext = vi.fn()
    render(true, onNext)
    handlers.nexttrack()
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('calls the latest onNext without setting the button again', () => {
    const first = vi.fn(), second = vi.fn()
    render(true, first)
    render(true, second)
    handlers.nexttrack()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(setActionHandler).toHaveBeenCalledTimes(1)
  })

  it('takes the button away with no next episode, and when the player goes', () => {
    render(true, () => {})
    render(false, () => {})
    expect(handlers.nexttrack).toBe(null)
    render(true, () => {})
    act(() => root.unmount())
    expect(handlers.nexttrack).toBe(null)
    root = createRoot(document.createElement('div'))
  })

  it('does nothing in a browser without media sessions, or without the action', () => {
    delete navigator.mediaSession
    expect(() => render(true, () => {})).not.toThrow()
    render(false, () => {})
    withSession(() => { throw new Error('not supported') })
    expect(() => { render(true, () => {}); render(false, () => {}) }).not.toThrow()
  })
})
