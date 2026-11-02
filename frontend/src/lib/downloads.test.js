import { describe, it, expect } from 'vitest'
import { streamRetryMs } from './downloads'

// The Downloads page's live stream, after it fails: again, waiting longer each time.
describe('streamRetryMs', () => {
  it('backs off from 2 s to at most a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(streamRetryMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
  })
})
