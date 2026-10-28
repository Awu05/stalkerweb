import { describe, it, expect } from 'vitest'
import { startPlaying } from './startPlaying'

const refusal = (name) => Object.assign(new Error(name), { name })

// A <video> whose play() answers as given, in turn (the last one again after).
// `pausesOnUnmute`: a browser that pauses it when it's unmuted outside a gesture (Safari).
function video(answers, { pausesOnUnmute = false } = {}) {
  const v = { calls: [], paused: true, _muted: false }
  Object.defineProperty(v, 'muted', {
    get: () => v._muted,
    set: (m) => { if (pausesOnUnmute && v._muted && !m && !v.paused) v.paused = true; v._muted = m },
  })
  v.play = () => {
    v.calls.push(v.muted)
    const a = answers.length > 1 ? answers.shift() : answers[0]
    if (a === 'ok') { v.paused = false; return Promise.resolve() }
    return Promise.reject(refusal(a))
  }
  return v
}

describe('startPlaying', () => {
  it('plays with sound when the browser allows it', async () => {
    const v = video(['ok'])
    expect(await startPlaying(v)).toEqual({ playing: true, muted: false })
    expect(v.muted).toBe(false)
  })

  it("changes nothing when a newer load cut the play short — first try or muted retry", async () => {
    const v = video(['AbortError'])
    expect(await startPlaying(v)).toBe(null)
    expect(v.calls).toEqual([false])   // no muted retry
    const w = video(['NotAllowedError', 'AbortError'])
    expect(await startPlaying(w)).toBe(null)
    expect(w.muted).toBe(false)        // not left muted by a retry that was cut short
  })

  it("says it didn't start when the file can't be played", async () => {
    expect(await startPlaying(video(['NotSupportedError']))).toEqual({ playing: false, muted: false, error: 'NotSupportedError' })
  })

  it('plays muted when sound is refused, then brings the sound back after a click on the page', async () => {
    const v = video(['NotAllowedError', 'ok'])
    expect(await startPlaying(v, { hadActivation: () => true })).toEqual({ playing: true, muted: false })
    expect(v.muted).toBe(false)
  })

  it('stays muted and playing when unmuting would stop it (Safari)', async () => {
    const v = video(['NotAllowedError', 'ok'], { pausesOnUnmute: true })
    expect(await startPlaying(v, { hadActivation: () => true })).toEqual({ playing: true, muted: true })
    expect(v.muted).toBe(true)
    expect(v.paused).toBe(false)
  })

  it('stays muted, and says so, when the page has had no click yet', async () => {
    const v = video(['NotAllowedError', 'ok'])
    expect(await startPlaying(v, { hadActivation: () => false })).toEqual({ playing: true, muted: true })
    expect(v.muted).toBe(true)
  })

  it("keeps the viewer's own mute", async () => {
    expect(await startPlaying(video(['ok']), { userMuted: true })).toEqual({ playing: true, muted: true })
    expect(await startPlaying(video(['NotAllowedError', 'ok']), { userMuted: true, hadActivation: () => true })).toEqual({ playing: true, muted: true })
  })

  it("is paused when even muted it won't play", async () => {
    expect(await startPlaying(video(['NotAllowedError']))).toEqual({ playing: false, muted: true, error: 'NotAllowedError' })
  })
})
