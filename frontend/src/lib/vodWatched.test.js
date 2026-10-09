import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../stalkerApi', () => ({
  getVodProgressBackend: vi.fn(async () => ({ entries: [] })),
  saveVodProgressBackend: vi.fn(async () => {}),
  removeVodProgressBackend: vi.fn(async () => {}),
}))
vi.mock('./profiles', () => ({ getActiveProfileId: () => 'p1' }))

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const { saveVodProgress, getWatchedVodIds } = await import('./vodProgress')

describe('watched titles', () => {
  beforeEach(() => store.clear())

  it('counts a title in progress, and remembers one finished after it leaves Continue Watching', () => {
    saveVodProgress({ key: '100', title: 'Heat', position: 600, duration: 6000 })
    saveVodProgress({ key: '200:s1:e3', title: 'Bluey', position: 590, duration: 600 })  // finished
    expect(getWatchedVodIds()).toEqual(new Set(['100', '200']))
  })

  it('does not count a title only just started', () => {
    saveVodProgress({ key: '300', title: 'Alien', position: 5, duration: 6000 })
    expect(getWatchedVodIds()).toEqual(new Set())
  })
})
