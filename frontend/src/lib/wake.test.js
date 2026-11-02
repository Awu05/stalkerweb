import { describe, it, expect } from 'vitest'
import { wakesOnReturn, WAKE_AFTER_HIDDEN_MS } from './wake'

describe('wakesOnReturn', () => {
  it('back on the tab after a while away: ask the server to reconnect', () => {
    const now = 1_000_000_000
    expect(WAKE_AFTER_HIDDEN_MS).toBe(5 * 60_000)
    expect(wakesOnReturn(now - 6 * 60_000, now)).toBe(true)
    expect(wakesOnReturn(now - 60_000, now)).toBe(false)   // a quick switch away: the poll covers it
    expect(wakesOnReturn(null, now)).toBe(false)           // never hidden
  })
})
