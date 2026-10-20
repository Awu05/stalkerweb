// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PasswordInput } from './password-input'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host
afterEach(() => { act(() => root.unmount()); host.remove() })

function mount(props) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<PasswordInput aria-label="Access key" defaultValue="s3cret" {...props} />))
  return { input: host.querySelector('input'), eye: host.querySelector('button') }
}

describe('PasswordInput', () => {
  it('hides what is typed until the eye is pressed, and hides it again', () => {
    const { input, eye } = mount()
    expect(input.type).toBe('password')
    expect(eye.getAttribute('aria-label')).toBe('Show password')
    act(() => eye.click())
    expect(input.type).toBe('text')
    expect(input.value).toBe('s3cret')
    expect(eye.getAttribute('aria-label')).toBe('Hide password')
    act(() => eye.click())
    expect(input.type).toBe('password')
  })

  it('does not submit the form it is in', () => {
    const { eye } = mount()
    expect(eye.type).toBe('button')
  })
})
