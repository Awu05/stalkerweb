// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TimezonePicker from './TimezonePicker'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no layout to scroll in.
Element.prototype.scrollIntoView = () => {}

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
const key = (input, k) => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent)

describe('TimezonePicker', () => {
  it('shows the zone there is, and every zone when opened', () => {
    const input = mount('Europe/London', vi.fn())
    expect(input.value).toMatch(/^Europe\/London/)
    act(() => input.focus())
    expect(options().length).toBeGreaterThan(100)
  })

  it('narrows the list as one types, and picks with Enter', () => {
    const onChange = vi.fn()
    const input = mount('Europe/London', onChange)
    act(() => input.focus())
    type(input, 'new york')
    expect(options()).toHaveLength(1)
    expect(options()[0]).toMatch(/America\/New York/)
    key(input, 'Enter')
    expect(onChange).toHaveBeenCalledWith('America/New_York')
    expect(host.querySelector('[role="listbox"]')).toBe(null)
  })

  it('moves with the arrows, and picks with a click', () => {
    const onChange = vi.fn()
    const input = mount('Europe/London', onChange)
    act(() => input.focus())
    type(input, 'europe/l')
    key(input, 'ArrowDown')
    const active = host.querySelector(`#${input.getAttribute('aria-activedescendant')}`)
    expect(active).not.toBe(null)
    act(() => host.querySelectorAll('[role="option"]')[0].click())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps the zone there was on Escape, and says when nothing matches', () => {
    const onChange = vi.fn()
    const input = mount('Europe/London', onChange)
    act(() => input.focus())
    type(input, 'atlantis')
    expect(host.textContent).toMatch(/No time zone matches/)
    key(input, 'Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toMatch(/^Europe\/London/)
  })
})
