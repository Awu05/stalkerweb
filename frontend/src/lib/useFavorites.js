import { useState, useEffect } from 'react'
import { getFavorites, addFavoriteChannel, removeFavoriteChannel } from '../stalkerApi'
import { showToast } from './toast'

let favsCache = null
let favsInflight = null
let favsGen = 0   // bumped on a viewer switch: a request from before can't fill the cache

export function loadFavorites() {
  if (favsCache) return Promise.resolve(favsCache)
  if (favsInflight) return favsInflight
  const gen = favsGen
  favsInflight = getFavorites()
    .then(r => { if (gen === favsGen) { favsCache = r; favsInflight = null } return r })
    .catch(e => { if (gen === favsGen) favsInflight = null; throw e })
  return favsInflight
}

function invalidateFavs() { favsCache = null }

// After a viewer switch (or disconnect): drop the cache and any request still
// loading the previous viewer's favorites.
export function invalidateFavoritesCache() { favsCache = null; favsInflight = null; favsGen++ }

export function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useState(new Set())

  useEffect(() => {
    let cancelled = false
    loadFavorites()
      .then(r => { if (!cancelled) setFavoriteIds(new Set(r.channels.map(c => String(c.uniqueId)))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  async function toggleFavorite(channel) {
    const id = String(channel.uniqueId)
    const wasIn = favoriteIds.has(id)
    // Optimistic update
    setFavoriteIds(prev => { const s = new Set(prev); wasIn ? s.delete(id) : s.add(id); return s })
    try {
      await (wasIn ? removeFavoriteChannel(id) : addFavoriteChannel(id))
      invalidateFavs()
    } catch {
      // Roll back on API failure
      setFavoriteIds(prev => { const s = new Set(prev); wasIn ? s.add(id) : s.delete(id); return s })
      showToast(wasIn ? 'Could not remove favorite' : 'Could not add favorite', 'error')
    }
  }

  return { favoriteIds, setFavoriteIds, toggleFavorite }
}
