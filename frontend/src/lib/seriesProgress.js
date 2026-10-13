// Where a viewer is in a show: what Continue plays, how an episode is named on
// a tile, and how much of a season is watched. Mirrored on Android
// (data/repo/SeriesProgress.kt) — keep the two in step.
//
// Keys are the watch keys "showId:seasonId:episodeId" (vodProgress makeVodKey).

const keyOf = (showId, season, episode) => `${showId}:${season.id}:${episode.episodeId}`
const parts = (key) => { const [, seasonId = '', episodeId = ''] = String(key).split(':'); return { seasonId, episodeId } }

/**
 * What Continue does for a show:
 * - the episode last played, unfinished → resume it;
 * - finished → the next episode not yet watched, into the next seasons;
 * - never played → the first episode not yet watched.
 * Returns { action: 'resume' | 'play', season, episode }, { needs: seasonId }
 * when a season's episodes must be loaded to know, or null once everything
 * after the last one played is watched.
 */
export function continueTarget({ showId, seasons, episodesBySeason, history = [], progress = [], watchedEpisodes = [] }) {
  const id = String(showId)
  const watched = new Set(watchedEpisodes)
  // "Resume" only where there's a point to resume from (it can drop off the list): else it plays from the start.
  const resumable = new Set(progress.map((e) => String(e.key)))
  const locate = (key) => {
    const { seasonId, episodeId } = parts(key)
    const season = seasons.find((s) => String(s.id) === seasonId)
    if (!season) return null
    const eps = episodesBySeason[season.id]
    if (!eps) return { needs: season.id }
    const episode = eps.find((e) => String(e.episodeId) === episodeId)
    return episode ? { action: resumable.has(String(key)) ? 'resume' : 'play', season, episode } : null
  }

  let after = null
  const last = history.find((e) => String(e.id) === id && String(e.key).includes(':'))
  if (last) {
    if (!last.finished && !watched.has(String(last.key))) {
      const found = locate(last.key)
      if (found) return found
    }
    after = parts(last.key)
  } else {
    const point = progress.find((e) => String(e.key).startsWith(`${id}:`) && !watched.has(String(e.key)))
    if (point) {
      const found = locate(point.key)
      if (found) return found
    }
  }

  // The next one not watched, from after the last played (or from the start).
  let si = after ? seasons.findIndex((s) => String(s.id) === after.seasonId) : 0
  if (si < 0) { si = 0; after = null }
  for (let i = si; i < seasons.length; i++) {
    const eps = episodesBySeason[seasons[i].id]
    if (!eps) return { needs: seasons[i].id }
    const from = after && i === si ? eps.findIndex((e) => String(e.episodeId) === after.episodeId) + 1 : 0
    for (let j = from; j < eps.length; j++) {
      if (!watched.has(keyOf(id, seasons[i], eps[j]))) return { action: 'play', season: seasons[i], episode: eps[j] }
    }
  }
  return null
}

/** A season's number, or the one in its name ("Season 4") when the portal leaves it out. */
export function seasonNoOf(season) {
  const n = String(season?.seasonNumber ?? '').trim()
  if (n) return n
  return /(\d+)/.exec(season?.name || '')?.[1] || ''
}

// "Episode 5", or nothing: no title of its own.
const isPlaceholder = (name, episode) => {
  const n = String(name || '').trim()
  return !n || /^episode\s*\d+$/i.test(n) || (!!episode && n === String(episode))
}

/** "S2 · E5 · The Long Night"; "S2 · E5" for an episode with no title of its own. */
export function episodeLabel({ season = '', episode = '', name = '' }) {
  const out = []
  if (season) out.push(`S${season}`)
  if (episode && episode !== '0') out.push(`E${episode}`)
  if (!isPlaceholder(name, episode)) out.push(String(name).trim())
  return out.join(' · ') || String(name || '').trim()
}

/** A Recently watched entry's episode, from its player link (as before for links saved without the season). */
export function historyEpisodeLabel(entry) {
  const q = new URLSearchParams(entry?.params || '')
  const season = q.get('season') || ''
  if (!season) return entry?.episodeTitle || ''
  return episodeLabel({ season, episode: q.get('series') || '', name: entry.episodeTitle || '' })
}

/** How many of a season's episodes are watched. */
export function watchedInSeason(watchedEpisodes, showId, seasonId) {
  const prefix = `${showId}:${seasonId}:`
  return watchedEpisodes.filter((k) => String(k).startsWith(prefix)).length
}

/** How many of these episodes (a season's, as listed now) are watched. */
export function watchedOfEpisodes(watchedEpisodes, showId, seasonId, episodes) {
  const w = new Set(watchedEpisodes)
  return episodes.filter((e) => w.has(`${showId}:${seasonId}:${e.episodeId}`)).length
}

/** "Watched", "2 of 3" (its episodes known), "2 watched", or nothing. */
export function seasonWatchedLabel(count, total) {
  if (!count) return ''
  if (total) return count >= total ? 'Watched' : `${count} of ${total}`
  return `${count} watched`
}
