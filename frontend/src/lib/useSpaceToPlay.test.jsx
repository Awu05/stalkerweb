// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSpaceToPlay, isTypingTarget } from './useSpaceToPlay'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root, host
// A player: its video and control bar, a menu over it, and a dialog that keeps its keys.
function Player({ toggle }) {
  useSpaceToPlay(toggle)
  return (
    <div>
      <video />
      <div data-player-controls>
        <button>Play</button>
        <input type="checkbox" aria-label="Loop" />
      </div>
      <div className="menu"><button>English</button></div>
      <div role="dialog" aria-modal="true" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
        <button>Switch</button>
      </div>
      <input aria-label="Search" />
      <div contentEditable suppressContentEditableWarning>notes</div>
    </div>
  )
}
function mount(toggle) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Player toggle={toggle} />))
}
afterEach(() => { act(() => root.unmount()); host.remove() })

const key = (target, type, init = {}) => {
  const e = new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}
const press = (target, init) => ({ down: key(target, 'keydown', init), up: key(target, 'keyup', init) })
const $ = (sel) => host.querySelector(sel)

describe('useSpaceToPlay', () => {
  it('plays or pauses on Space with nothing focused, and keeps the page from scrolling', () => {
    const toggle = vi.fn()
    mount(toggle)
    const { down, up } = press(document.body)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(down.defaultPrevented && up.defaultPrevented).toBe(true)
  })

  it('on the video, and on a control the mouse left the focus on — which would otherwise press itself', () => {
    const toggle = vi.fn()
    mount(toggle)
    press($('video'))
    const { down, up } = press($('[data-player-controls] button'))
    expect(toggle).toHaveBeenCalledTimes(2)
    expect(down.defaultPrevented && up.defaultPrevented).toBe(true)
  })

  it("leaves Space to a menu's item, and to a dialog that keeps its keys", () => {
    const toggle = vi.fn()
    mount(toggle)
    expect(press($('.menu button')).down.defaultPrevented).toBe(false)
    expect(press($('[role="dialog"] button')).down.defaultPrevented).toBe(false)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('leaves Space to typing — text boxes and editable text — down and up', () => {
    const toggle = vi.fn()
    mount(toggle)
    for (const t of [$('input[aria-label="Search"]'), $('[contenteditable]')]) {
      const { down, up } = press(t)
      expect(down.defaultPrevented || up.defaultPrevented).toBe(false)
    }
    expect(toggle).not.toHaveBeenCalled()
  })

  it('ignores Ctrl, Alt or Cmd + Space', () => {
    const toggle = vi.fn()
    mount(toggle)
    press(document.body, { ctrlKey: true })
    press(document.body, { altKey: true })
    press(document.body, { metaKey: true })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('toggles once for a press held down', () => {
    const toggle = vi.fn()
    mount(toggle)
    key(document.body, 'keydown')
    key(document.body, 'keydown', { repeat: true })
    key(document.body, 'keydown', { repeat: true })
    key(document.body, 'keyup')
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe('isTypingTarget', () => {
  it('counts text boxes, not the inputs Space presses or ticks', () => {
    const el = (tag, type) => Object.assign(document.createElement(tag), type ? { type } : {})
    expect(isTypingTarget(el('input'))).toBe(true)
    expect(isTypingTarget(el('input', 'search'))).toBe(true)
    expect(isTypingTarget(el('textarea'))).toBe(true)
    expect(isTypingTarget(el('input', 'checkbox'))).toBe(false)
    expect(isTypingTarget(el('input', 'submit'))).toBe(false)
    expect(isTypingTarget(el('button'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
