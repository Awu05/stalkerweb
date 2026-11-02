import { describe, it, expect } from 'vitest'
import { keepLists } from './channelCache'

// Right after the server reconnects, its lists can come back empty with
// loading: true. A list already shown is kept until the real one arrives.
describe('keepLists', () => {
  const shown = { channels: [{ uniqueId: 'a' }], groups: [{ id: '1', name: 'News' }] }

  it('an empty answer while loading keeps what is shown', () => {
    expect(keepLists(shown, { channels: [], groups: [], loading: true })).toEqual({ ...shown, loading: true })
  })

  it('a real answer replaces it; an empty one once loading ended too', () => {
    const next = { channels: [{ uniqueId: 'b' }], groups: [{ id: '2', name: 'Sports' }], loading: true }
    expect(keepLists(shown, next)).toEqual(next)
    expect(keepLists(shown, { channels: [], groups: [], loading: false })).toEqual({ channels: [], groups: [], loading: false })
  })

  it('only the lists given are looked at', () => {
    expect(keepLists(shown, { channels: [], loading: true })).toEqual({ channels: shown.channels, loading: true })
  })
})
