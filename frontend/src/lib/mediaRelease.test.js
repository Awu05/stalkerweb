import { describe, it, expect } from 'vitest'
import { releaseMedia } from './mediaRelease'

// A <video> as far as releaseMedia uses it.
function fakeVideo() {
  const calls = []
  return {
    calls,
    src: 'http://server/proxy/stream/42',
    pause: () => calls.push('pause'),
    removeAttribute: (name) => calls.push(`remove:${name}`),
    load: () => calls.push('load'),
  }
}

describe('releaseMedia', () => {
  it('pauses the video, drops its source and lets go of the stream', () => {
    const v = fakeVideo()
    releaseMedia(v)
    expect(v.calls).toEqual(['pause', 'remove:src', 'load'])
  })

  it('does nothing without a video', () => {
    expect(() => releaseMedia(null)).not.toThrow()
  })

  it("doesn't throw when the element is already gone", () => {
    expect(() => releaseMedia({ pause: () => { throw new Error('gone') }, removeAttribute() {}, load() {} })).not.toThrow()
  })
})
