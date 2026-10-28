// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TimezonePicker from './TimezonePicker'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root, host
function mount(value, onChange) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<TimezonePicker id="tz" value={value} onChange={onChange} />))
  return host.querySelector('input')
}
afterEach(() => { act(() => root.unmount()); host.remove() })

// Typing as React hears it (its onChange listens for the native input event).
function type(input, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  act(() => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const key = (input, k, init = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  act(() => { input.dispatchEvent(e) })
  return e
}
// The list is put on the page itself (it floats over the form).
const list = () => document.querySelector('[role="listbox"]')
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)

describe('TimezonePicker', () => {
  it('shows the zone there is, and lists every zone on a click — not on focus alone', () => {
    const input = mount('Europe/London', vi.fn())
    expect(input.value).toMatch(/^Europe\/London/)
    act(() => input.focus())
    expect(list()).toBe(null)
    act(() => input.click())
    expect(options().length).toBeGreaterThan(400)
  })

  it('leaves the arrows to the form while closed (Alt+↓ opens it)', () => {
    const input = mount('Europe/London', vi.fn())
    expect(key(input, 'ArrowDown').defaultPrevented).toBe(false)
    expect(list()).toBe(null)
    key(input, 'ArrowDown', { altKey: true })
    expect(list()).not.toBe(null)
  })

  it('narrows the list as one types, and picks with Enter', () => {
    const onChange = vi.fn()
    const input = mount('Europe/London', onChange)
    act(() => input.click())
    type(input, 'new york')
    expect(options()).toHaveLength(1)
    expect(options()[0]).toMatch(/America\/New York/)
    key(input, 'Enter')
    expect(onChange).toHaveBeenCalledWith('America/New_York')
    expect(list()).toBe(null)
  })

  it('starts a fresh search when one types after a pick', () => {
    const input = mount('Europe/London', vi.fn())
    type(input, `${input.value}k`)   // a key typed into the box as it shows the zone
    expect(input.value).toBe('k')
    expect(options().length).toBeGreaterThan(0)
  })

  it('finds by offset, and offers a real zone typed in full that the list has not', () => {
    const onChange = vi.fn()
    const input = mount('Europe/London', onChange)
    act(() => input.click())
    type(input, 'Etc/GMT-3')
    expect(options()[0]).toMatch(/Use “Etc\/GMT-3”/)
    key(input, 'Enter')
    expect(onChange).toHaveBeenCalledWith('Etc/GMT-3')
  })

  it('keeps the zone there was on Escape or a TV Back, and says when nothing matches', () => {
    const onChange = vi.fn()
    const input = mount('Europe/London', onChange)
    act(() => input.click())
    type(input, 'atlantis')
    expect(document.body.textContent).toMatch(/No time zone matches/)
    key(input, 'Escape')
    expect(list()).toBe(null)
    act(() => input.click())
    key(input, 'GoBack')
    expect(list()).toBe(null)
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toMatch(/^Europe\/London/)
  })
})
