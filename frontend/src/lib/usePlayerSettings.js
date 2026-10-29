import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from './appContext'
import { showToast } from './toast'
import { serialSaves } from './serialSaves'
import { getMyViewer, saveMyFilters } from '../stalkerApi'

const save = serialSaves(saveMyFilters)

/**
 * This viewer's player settings, kept on the server (so they follow them to
 * every device): intro skipping ('off' | 'button' | 'auto') and the preferred
 * audio language ('' for the stream's own, or two letters). Null until read.
 * `change({ skipMode?, audioLanguage? })` shows the change at once and puts
 * it back if the save fails.
 */
export function usePlayerSettings() {
  const { viewer } = useApp()
  const [settings, setSettings] = useState(null)
  const settingsRef = useRef(null)
  useEffect(() => { settingsRef.current = settings })

  useEffect(() => {
    let cancelled = false
    getMyViewer()
      .then((me) => { if (!cancelled) setSettings({ skipMode: me.skipMode || (me.autoSkip ? 'auto' : 'button'), audioLanguage: me.audioLanguage || '' }) })
      .catch(() => { if (!cancelled) setSettings({ skipMode: 'button', audioLanguage: '' }) })
    return () => { cancelled = true }
  }, [viewer?.id])

  const change = useCallback((patch) => {
    const before = settingsRef.current
    setSettings((s) => ({ ...(s ?? { skipMode: 'button', audioLanguage: '' }), ...patch }))
    save(patch).catch((e) => {
      setSettings((s) => (s && before ? { ...s, ...Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])) } : s))
      showToast(`Couldn't save: ${e.message}`, 'error')
    })
  }, [])

  return { settings, change }
}
