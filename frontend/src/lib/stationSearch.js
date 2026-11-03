// Whether a channel matches what was typed in the Guide's station search:
// part of its name (any case), or the start of its channel number.
export function matchesStation(channel, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  if (/^\d+$/.test(q) && channel.number > 0 && String(channel.number).startsWith(q)) return true
  return String(channel.name ?? '').toLowerCase().includes(q)
}

// Whether the Guide shows a channel: the search matches it and, with
// favoritesOnly's ids (null = every channel), it's one of the favorites.
export function shownInGuide(channel, query, favoriteIds) {
  if (favoriteIds && !favoriteIds.has(String(channel.uniqueId))) return false
  return matchesStation(channel, query)
}

// What the Guide says when it has no channels to show. favoriteCount: how
// many favorites the viewer has — some, none shown: the channel filters (Show
// Adult, hidden genres and languages) hide them, or they're not in this list.
export function guideEmptyMessage(query, favoritesOnly, favoriteCount = 0) {
  const q = String(query ?? '').trim()
  if (favoritesOnly) {
    if (q) return `No favorite stations match “${q}”.`
    return favoriteCount > 0
      ? 'None of your favorite channels are in this guide — your channel filters may hide them.'
      : 'No favorite channels yet — add one with the heart on a channel.'
  }
  return q ? `No stations match “${q}”.` : 'No channels to show.'
}
