// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSpaceToPlay } from './useSpaceToPlay'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root, host
function Player({ toggle, onButton }) {
  useSpaceToPlay(toggle)
  return (
    <div>
      <button onClick={onButton}>Play</button>
      <input aria-label="Search" />
    </div>
  )
}
function mount(props) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Player {...props} />))
}
afterEach(() => { act(() => root.unmount()); host.remove() })

const press = (target, init = {}) => {
  const down = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(down)
  const up = new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(up)
  return { down, up }
}

describe('useSpaceToPlay', () => {
  it('plays or pauses on Space, and keeps it from the page', () => {
    const toggle = vi.fn()
    mount({ toggle, onButton: () => {} })
    const { down, up } = press(document.body)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(down.defaultPrevented).toBe(true)   // no scrolling
    expect(up.defaultPrevented).toBe(true)
  })

  it('takes Space from a focused button, which would otherwise undo the toggle', () => {
    const toggle = vi.fn()
    const onButton = vi.fn()
    mount({ toggle, onButton })
    const button = host.querySelector('button')
    const buttonKeys = vi.fn()
    button.addEventListener('keydown', buttonKeys)
    button.addEventListener('keyup', buttonKeys)
    const { down, up } = press(button)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(buttonKeys).not.toHaveBeenCalled()
    expect(down.defaultPrevented && up.defaultPrevented).toBe(true)
  })

  it('leaves Space to a text box, and toggles once while held', () => {
    const toggle = vi.fn()
    mount({ toggle, onButton: () => {} })
    const { down } = press(host.querySelector('input'))
    expect(toggle).not.toHaveBeenCalled()
    expect(down.defaultPrevented).toBe(false)
    press(document.body, { repeat: true })
    expect(toggle).not.toHaveBeenCalled()
  })
})
