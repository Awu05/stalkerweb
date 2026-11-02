import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// What a timer or a poll asks for goes with X-Background: 1, so it never wakes
// the server's portal session (asleep after the idle timeout — backend
// middleware/session.js). Someone opening a page sends none.
describe('background requests', () => {
  let seen
  beforeEach(() => {
    vi.resetModules()
    globalThis.window = new EventTarget()
    seen = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      seen.push({ url, background: new Headers(opts.headers).get('X-Background') })
      return new Response(JSON.stringify({}), { status: 200 })
    }))
  })
  afterEach(() => {
    delete globalThis.window
    vi.unstubAllGlobals()
  })

  it('every polling helper can mark its request', async () => {
    const api = await import('../stalkerApi')
    const bg = { background: true }
    await api.getStatus(bg)
    await api.getChannels(null, false, bg)
    await api.getChannelProgress(bg)
    await api.getChannelHealth(bg)
    await api.getChannelEpg('1', 6, bg)
    await api.getNowNext(bg)
    await api.getActivity(bg)
    await api.getStreamDelivery('live', '1', bg)
    await api.pingServer(bg)
    await api.streamKeepalive(bg)
    await api.getRecordings(false, bg)
    expect(seen).toHaveLength(11)
    for (const r of seen) expect(r, r.url).toMatchObject({ background: '1' })
  })

  it('a request someone makes carries no mark', async () => {
    const api = await import('../stalkerApi')
    await api.getChannels()
    await api.getNowNext()
    await api.getChannelHealth()
    expect(seen.map((r) => r.background)).toEqual([null, null, null])
  })
})
