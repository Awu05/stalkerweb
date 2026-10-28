import { describe, it, expect } from 'vitest'
import { startPlaying } from './startPlaying'

const refusal = (name) => Object.assign(new Error(name), { name })

// A <video> whose play() answers as given, in turn (the last one again after).
function video(...answers) {
  const v = { muted: false, calls: [] }
  v.play = () => {
    v.calls.push(v.muted)
    const a = answers.length > 1 ? answers.shift() : answers[0]
    return a === 'ok' ? Promise.resolve() : Promise.reject(refusal(a))
  }
  return v
}

describe('startPlaying', () => {
  it('plays with sound when the browser allows it', async () => {
    const v = video('ok')
    expect(await startPlaying(v)).toEqual({ playing: true, muted: false })
    expect(v.muted).toBe(false)
  })

  it("doesn't mute when a newer load cut the play short", async () => {
    const v = video('AbortError')
    expect(await startPlaying(v)).toBe(null)
    expect(v.muted).toBe(false)
    expect(v.calls).toEqual([false])   // no muted retry
  })

  it('plays muted when sound is refused, then brings the sound back after a click on the page', async () => {
    const v = video('NotAllowedError', 'ok')
    expect(await startPlaying(v, { hadActivation: () => true })).toEqual({ playing: true, muted: false })
    expect(v.muted).toBe(false)
  })

  it('stays muted, and says so, when the page has had no click yet', async () => {
    const v = video('NotAllowedError', 'ok')
    expect(await startPlaying(v, { hadActivation: () => false })).toEqual({ playing: true, muted: true })
    expect(v.muted).toBe(true)
  })

  it("keeps the viewer's own mute", async () => {
    const v = video('ok')
    expect(await startPlaying(v, { userMuted: true })).toEqual({ playing: true, muted: true })
    const w = video('NotAllowedError', 'ok')
    expect(await startPlaying(w, { userMuted: true, hadActivation: () => true })).toEqual({ playing: true, muted: true })
  })

  it("is paused when even muted it won't play", async () => {
    expect(await startPlaying(video('NotAllowedError'))).toEqual({ playing: false, muted: true })
  })
})
