import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The website's reactions when its viewer was deleted on another device, and
// the favorites cache across a viewer switch.
describe('viewer switching on the website', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.window = new EventTarget()
  })
  afterEach(() => {
    delete globalThis.window
    vi.unstubAllGlobals()
  })

  it('announces VIEWER_GONE when the server says the viewer was deleted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'This viewer was deleted. Pick who is watching.', viewerGone: true }),
      { status: 409 },
    )))
    const api = await import('../stalkerApi')
    const seen = vi.fn()
    window.addEventListener(api.VIEWER_GONE, seen)
    await expect(api.getMyViewer()).rejects.toThrow(/deleted/)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not keep the previous viewer\'s favorites request after a switch', async () => {
    const answers = []
    vi.doMock('../stalkerApi', () => ({
      getFavorites: vi.fn(() => new Promise((resolve) => answers.push(resolve))),
      addFavoriteChannel: vi.fn(),
      removeFavoriteChannel: vi.fn(),
    }))
    const favs = await import('./useFavorites')
    const first = favs.loadFavorites()          // the previous viewer's, still loading
    favs.invalidateFavoritesCache()            // switched viewer
    const second = favs.loadFavorites()
    expect(answers.length).toBe(2)              // a new request, not the old one
    answers[1]({ channels: [{ uniqueId: 'new' }], groups: [] })
    answers[0]({ channels: [{ uniqueId: 'old' }], groups: [] })
    await Promise.all([first, second])
    const again = await favs.loadFavorites()    // the late old answer was not cached
    expect(again.channels[0].uniqueId).toBe('new')
  })
})
