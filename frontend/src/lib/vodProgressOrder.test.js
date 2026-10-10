import { describe, it, expect, vi } from 'vitest'

// Requests answered by hand, in whatever order a test chooses.
const pending = []
const answerLater = () => new Promise((resolve) => pending.push(resolve))
vi.mock('../stalkerApi', () => ({
  getWatch: vi.fn(answerLater),
  saveWatch: vi.fn(answerLater),
  addToWatchList: vi.fn(answerLater),
  removeFromWatchList: vi.fn(answerLater),
  setWatchListCompleted: vi.fn(answerLater),
  removeWatchTitle: vi.fn(answerLater),
  clearWatchHistory: vi.fn(answerLater),
}))

const vod = await import('./vodProgress')
const lists = (list) => ({ progress: [], history: [], watched: [], list })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('answers that arrive out of order', () => {
  it('do not undo a My List change made after they were sent', async () => {
    vod.saveVodProgress({ key: '100', position: 60, duration: 600 })   // in flight
    vod.toggleMyList({ id: '7', name: 'Heat' })                          // added here
    expect(vod.isInMyList('7')).toBe(true)

    pending[0](lists([]))                                                // the save answers with the old list
    await flush()
    expect(vod.isInMyList('7')).toBe(true)

    pending[1](lists([{ id: '7', item: { id: '7' }, addedAt: 1, completedAt: null }]))
    await flush()
    expect(vod.isInMyList('7')).toBe(true)
  })

  it('do not replace a newer answer with an older one', async () => {
    pending.length = 0
    const load1 = vod.loadWatch()
    const load2 = vod.loadWatch()
    pending[1](lists([{ id: '9', item: { id: '9' }, addedAt: 2, completedAt: null }]))
    await load2
    pending[0](lists([]))
    await load1
    expect(vod.isInMyList('9')).toBe(true)
  })
})
