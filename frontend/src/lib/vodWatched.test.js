import { describe, it, expect, vi, beforeEach } from 'vitest'

// The server's answers, as the backend WatchStore would give them.
let server
vi.mock('../stalkerApi', () => ({
  getWatch: vi.fn(async () => server),
  saveWatch: vi.fn(async () => server),
  removeWatchTitle: vi.fn(async () => server),
  clearWatchHistory: vi.fn(async () => server),
}))

const vod = await import('./vodProgress')

describe('what the viewer watched', () => {
  beforeEach(async () => {
    server = {
      progress: [{ key: '200:s1:e2', position: 300, duration: 1200 }],
      history: [{ id: '200', key: '200:s1:e2' }, { id: '100', key: '100', finished: true }],
      watched: ['100', '300'],
    }
    await vod.loadWatch()
  })

  it('comes from the server, for the viewer — whatever device this is', () => {
    expect(vod.getVodHistory().map((e) => e.id)).toEqual(['200', '100'])
    expect(vod.getVodProgress('200:s1:e2')).toMatchObject({ position: 300 })
    expect(vod.getVodProgress('999')).toBe(null)
  })

  it('counts titles started or finished for the "Not watched" filter', () => {
    expect(vod.getWatchedVodIds()).toEqual(new Set(['100', '300', '200']))
  })

  it('takes the lists the server answers a save with, and tells whoever listens', async () => {
    const seen = vi.fn()
    const stop = vod.onWatchChange(seen)
    server = { progress: [], history: [{ id: '400', key: '400' }], watched: [] }
    vod.saveVodProgress({ key: '400', position: 600, duration: 6000 })
    await new Promise((r) => setTimeout(r, 0))
    expect(vod.getVodHistory().map((e) => e.id)).toEqual(['400'])
    expect(seen).toHaveBeenCalled()
    stop()
  })

  it('removes a title from the history at once, resume points too', () => {
    vod.removeFromVodHistory('200')
    expect(vod.getVodHistory().map((e) => e.id)).toEqual(['100'])
    expect(vod.getVodProgress('200:s1:e2')).toBe(null)
  })
})
