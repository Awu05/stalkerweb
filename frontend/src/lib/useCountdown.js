import { useEffect, useRef, useState } from 'react'

const STEP_MS = 250

/**
 * Seconds left of a `secs`-second countdown while `active` (null when not),
 * counting only time spent `running` — a pause keeps what was counted; `onDone`
 * once at 0, while running (with 0 s, as soon as it runs). Made inactive, it starts from `secs` again next time. The apps'
 * NextCountdown (SkipSegments.kt) counts the same way.
 */
export function useCountdown(active, running, secs, onDone) {
  const [counted, setCounted] = useState(0)   // ms
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })
  const firedRef = useRef(false)
  useEffect(() => { if (!active) { setCounted(0); firedRef.current = false } }, [active])
  useEffect(() => {
    if (!active || !running) return
    let last = Date.now()
    const id = setInterval(() => {
      const now = Date.now()
      const step = now - last   // taken now: the update below runs later
      last = now
      setCounted((c) => c + step)
    }, STEP_MS)
    return () => {
      clearInterval(id)
      const step = Date.now() - last   // since the last step: kept, not lost to the pause
      setCounted((c) => c + step)
    }
  }, [active, running])
  const left = Math.max(0, secs - Math.floor(counted / 1000))
  useEffect(() => {
    if (!active || !running || left > 0 || firedRef.current) return
    firedRef.current = true
    doneRef.current()
  }, [active, running, left])
  return active ? left : null
}
