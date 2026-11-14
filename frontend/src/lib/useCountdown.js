import { useEffect, useRef, useState } from 'react'

/**
 * Seconds left of a `secs`-second countdown while `active` (null when not),
 * ticking only while `running`; `onDone` once at 0. Made inactive, it starts
 * from `secs` again next time.
 */
export function useCountdown(active, running, secs, onDone) {
  const [left, setLeft] = useState(secs)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })
  useEffect(() => { if (!active) setLeft(secs) }, [active, secs])
  useEffect(() => {
    if (!active || !running) return
    if (left <= 0) { doneRef.current(); return }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [active, running, left])
  return active ? left : null
}
