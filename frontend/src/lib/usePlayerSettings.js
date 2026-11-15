import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from './appContext'
import { showToast } from './toast'
import { serialSaves } from './serialSaves'
import { getMyViewer, saveMyFilters } from '../stalkerApi'
import { nextEpisodeDelayOf } from './skipSegments'

const save = serialSaves(saveMyFilters)
const DEFAULTS = { skipMode: 'button', audioLanguage: '', nextEpisodeDelay: null }

/**
 * This viewer's player settings, kept on the server (so they follow them to
 * every device): intro skipping ('off' | 'button' | 'auto') and the preferred
 * audio language ('' for the stream's own, or two letters), and when the next
 * episode plays by itself (nextEpisodeDelay: seconds, 0 at once, -1 never;
 * null when it couldn't be read — then nothing plays by itself).
 * Null until read. `change({ skipMode?, audioLanguage?, nextEpisodeDelay? })`
 * shows the change at once and puts it back if the save fails.
 */
export function usePlayerSettings() {
  const { viewer } = useApp()
  const [settings, setSettings] = useState(null)
  const settingsRef = useRef(null)
  useEffect(() => { settingsRef.current = settings })

  useEffect(() => {
    let cancelled = false
    getMyViewer()
      .then((me) => { if (!cancelled) setSettings({ skipMode: me.skipMode || (me.autoSkip ? 'auto' : 'button'), audioLanguage: me.audioLanguage || '', nextEpisodeDelay: nextEpisodeDelayOf(me) }) })
      .catch(() => { if (!cancelled) setSettings({ ...DEFAULTS }) })
    return () => { cancelled = true }
  }, [viewer?.id])

  const change = useCallback((patch) => {
    const before = settingsRef.current
    setSettings((s) => ({ ...(s ?? DEFAULTS), ...patch }))
    save(patch).catch((e) => {
      setSettings((s) => (s && before ? { ...s, ...Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])) } : s))
      showToast(`Couldn't save: ${e.message}`, 'error')
    })
  }, [])

  return { settings, change }
}
