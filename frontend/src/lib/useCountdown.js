import { useEffect, useRef, useState } from 'react'

const STEP_MS = 250

/**
 * Seconds left of a `secs`-second countdown while `active` (null when not),
 * counting only time spent `running` — a pause keeps what was counted; `onDone`
 * once at 0. Made inactive, it starts from `secs` again next time. The apps'
 * NextCountdown (SkipSegments.kt) counts the same way.
 */
export function useCountdown(active, running, secs, onDone) {
  const [counted, setCounted] = useState(0)   // ms
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })
  useEffect(() => { if (!active) setCounted(0) }, [active])
  useEffect(() => {
    if (!active || !running) return
    let last = Date.now()
    const id = setInterval(() => {
      const now = Date.now()
      const step = now - last   // taken now: the update below runs later
      last = now
      setCounted((c) => c + step)
    }, STEP_MS)
    return () => clearInterval(id)
  }, [active, running])
  const left = Math.max(0, secs - Math.floor(counted / 1000))
  useEffect(() => { if (active && left === 0) doneRef.current() }, [active, left])
  return active ? left : null
}
