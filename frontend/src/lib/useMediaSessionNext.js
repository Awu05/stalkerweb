import { useEffect, useRef } from 'react'

// The browser's own "next track" button — in its picture-in-picture window
// (Chrome, Edge) and for a keyboard's media keys — while `on` (a next
// episode to play), calling the latest `onNext`. Nothing in a browser without
// media sessions, or one that doesn't know the action.
const setHandler = (fn) => {
  try { navigator.mediaSession?.setActionHandler('nexttrack', fn) } catch { /* action not supported */ }
}

export function useMediaSessionNext(on, onNext) {
  const onNextRef = useRef(onNext)
  useEffect(() => { onNextRef.current = onNext })
  useEffect(() => {
    if (!on) return
    setHandler(() => onNextRef.current?.())
    return () => setHandler(null)
  }, [on])
}
