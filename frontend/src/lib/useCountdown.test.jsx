// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useCountdown } from './useCountdown'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root, host, left, onDone
function Probe({ active, running }) {
  left = useCountdown(active, running, 5, onDone)
  return null
}
const render = (active, running) => act(() => root.render(<Probe active={active} running={running} />))
// A second at a time: each tick schedules the next once React has rendered it.
const tick = (secs) => { for (let i = 0; i < secs; i++) act(() => { vi.advanceTimersByTime(1000) }) }

beforeEach(() => {
  vi.useFakeTimers()
  onDone = vi.fn()
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

describe('useCountdown', () => {
  it('counts down from 5 and fires once at 0', () => {
    render(true, true)
    expect(left).toBe(5)
    tick(4)
    expect(left).toBe(1)
    expect(onDone).not.toHaveBeenCalled()
    tick(1)
    expect(left).toBe(0)
    expect(onDone).toHaveBeenCalledTimes(1)
    tick(5)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('holds while paused and carries on when playing again', () => {
    render(true, true)
    tick(2)
    render(true, false)
    tick(10)
    expect(left).toBe(3)
    expect(onDone).not.toHaveBeenCalled()
    render(true, true)
    tick(3)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('is null when inactive, and starts again from 5 when active again', () => {
    render(false, true)
    expect(left).toBeNull()
    render(true, true)
    tick(3)
    render(false, true)
    expect(left).toBeNull()
    tick(10)
    expect(onDone).not.toHaveBeenCalled()
    render(true, true)
    expect(left).toBe(5)
  })
})
