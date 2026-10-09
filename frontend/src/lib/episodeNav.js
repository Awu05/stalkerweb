// The episodes before and after the one playing, across seasons: after a
// season's last episode comes the next season's first. `seasons` are in order
// (the server sorts them), `episodesBySeason` holds the seasons loaded so far.
// Returns { prev, next } as { season, episode } or null, and `needs`: the
// seasons next door that must be loaded to know (at a season's first or last
// episode).
export function episodeNeighbours(seasons, episodesBySeason, seasonId, episodeId) {
  const none = { prev: null, next: null, needs: [] }
  const si = seasons.findIndex((s) => s.id === seasonId)
  const eps = episodesBySeason[seasonId]
  if (si < 0 || !eps) return none
  const ei = eps.findIndex((e) => e.episodeId === episodeId)
  if (ei < 0) return none

  const needs = []
  const side = (offset) => {
    const within = eps[ei + offset]
    if (within) return { season: seasons[si], episode: within }
    const season = seasons[si + offset]
    if (!season) return null
    const list = episodesBySeason[season.id]
    if (!list) { needs.push(season.id); return null }
    const episode = offset > 0 ? list[0] : list[list.length - 1]
    return episode ? { season, episode } : null
  }
  return { prev: side(-1), next: side(1), needs }
}
