// Settings → Activity: the words for what's playing (backend routes/activity.js).

/** How long something has played: "just now", "12 min", "1 h 5 min". */
export function playingFor(startedAt, now = Date.now()) {
  const mins = Math.floor(Math.max(0, now - startedAt) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60), m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** The badge: Live, Movie, Episode — on a TV, "Cast". */
export function kindLabel(stream) {
  if (stream.via === 'cast') return 'Cast'
  if (stream.kind === 'live') return 'Live'
  return String(stream.id).includes(':') ? 'Episode' : 'Movie'
}

/** How it got here: the app or a browser; an Xtream player or a playlist link. */
export function viaLabel(stream) {
  return { cast: 'cast to a TV', xtream: 'Xtream player', link: 'playlist link' }[stream.via] || ''
}

/** "portal.example · 2 open streams · 1 channel cast to a TV". */
export function portalSummary(p) {
  if (!p?.connected) return 'Portal not connected'
  const parts = [p.host || 'Portal']
  parts.push(p.openStreams === 1 ? '1 open stream' : `${p.openStreams || 0} open streams`)
  if (p.casting) parts.push(p.casting === 1 ? '1 channel cast to a TV' : `${p.casting} channels cast to a TV`)
  return parts.join(' · ')
}
