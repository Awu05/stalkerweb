import { useEffect, useState } from 'react'
import { getVodListing } from '../stalkerApi'

const POLL_MS = 1200

// A VOD category's whole listing, for the filters: the server reads it page by
// page (paced, cached for an hour), and this asks for what's new every second
// or so until it's complete. Off (`enabled` false) it holds nothing.
export function useCategoryListing(type, categoryId, enabled) {
  const [state, setState] = useState({ items: [], loaded: 0, total: 0, complete: false, partial: false, error: '' })

  useEffect(() => {
    setState({ items: [], loaded: 0, total: 0, complete: false, partial: false, error: '' })
    if (!enabled || !categoryId) return
    let cancelled = false
    let timer = null
    let items = []
    const poll = async () => {
      try {
        const r = await getVodListing({ type, category: categoryId, from: items.length })
        if (cancelled) return
        items = items.concat(r.items ?? [])
        setState({ items, loaded: r.loaded, total: r.total, complete: !!r.complete, partial: !!r.partial, error: '' })
        if (!r.complete) timer = setTimeout(poll, POLL_MS)
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: e.message }))
      }
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [type, categoryId, enabled])

  return state
}
