// Getting a frozen live stream going again without rewinding it.
//
// Where a source restarts, the browser's player often leaves a small hole in
// the video it has loaded and then sits in front of it, frozen, with more
// video already loaded just past the hole. Jumping over the hole is enough.
// When a full reconnect is still needed, the new player rejoins at the segment
// it was playing instead of a few segments back, which replayed what was
// already seen.

// Where to jump to get past a hole in the loaded video, or null when there is
// nothing loaded ahead to jump to (then the player is simply waiting for data).
// `buffered` is a list of [start, end] ranges in seconds, in order.
export function jumpTarget(buffered, currentTime, maxGap = 10) {
  const t = currentTime
  for (const [start, end] of buffered) {
    // Stuck inside a range with plenty loaded ahead: a decoder stall — nudge.
    if (start <= t && t < end) {
      if (end - t >= 1) return t + 0.2
      continue // at the end of this range: look at the next one
    }
    // The next range starts a little ahead: jump into it.
    if (start > t && start - t <= maxGap) return start + 0.1
  }
  return null
}

// The time to start a rejoining player at: the same spot in the segment it was
// playing (`resume` = { sn, offset }), or null when that segment is no longer
// listed. `fragments` are hls.js's fragments of the freshly loaded playlist.
export function resumePosition(fragments, resume) {
  if (!resume) return null
  const frag = fragments.find(f => f.sn === resume.sn)
  if (!frag) return null
  return frag.start + Math.min(Math.max(0, resume.offset), Math.max(0, frag.duration - 0.5))
}

// The ranges of a <video>'s TimeRanges as [start, end] pairs.
export function rangesOf(timeRanges) {
  const out = []
  for (let i = 0; i < (timeRanges?.length ?? 0); i++) out.push([timeRanges.start(i), timeRanges.end(i)])
  return out
}

// One tick of the player's stall watchdog. `state` is { lastTime, lastAdvance,
// jumped }; returns the next state and what to do: null, { jumpTo } (seek past a
// hole, once per freeze) or 'reconnect' (12 s frozen). A jump is not playback:
// the clock keeps counting from when the freeze began, so a jump that doesn't
// help never delays the reconnect.
export function watchdogTick(state, { now, currentTime, idle, buffered }) {
  if (idle || currentTime > state.lastTime + 0.25) {
    return { state: { lastTime: currentTime, lastAdvance: now, jumped: false }, action: null }
  }
  const frozenFor = now - state.lastAdvance
  if (!state.jumped && frozenFor >= 3000) {
    const to = jumpTarget(buffered, currentTime)
    if (to !== null) return { state: { ...state, lastTime: to, jumped: true }, action: { jumpTo: to } }
    state = { ...state, jumped: true }
  }
  return { state, action: frozenFor > 12000 ? 'reconnect' : null }
}
