// Helpers for Settings → My channels (components/ChannelFilters.jsx).
import { languageOf } from './languages'

// Category names compared without case or stray spaces — the same rule as the
// server (backend/lib/vodCategoryFilter.js).
export const titleKey = (title) => String(title ?? '').trim().toUpperCase()

const isAllCategory = (c) => String(c.id) === '*' || titleKey(c.title) === 'ALL'

// Movie and series categories as one list of names: each name once (a movie
// and a series category with the same name are hidden together), sorted,
// without the portal's "All" pseudo-category.
export function vodCategoryList(movies = [], series = []) {
  const byKey = new Map()
  for (const c of [...movies, ...series]) {
    if (isAllCategory(c)) continue
    const name = String(c.title ?? '').trim()
    if (name && !byKey.has(titleKey(name))) byKey.set(titleKey(name), name)
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b))
}

// Live TV categories grouped by the part before the "|" ("BEIN SPORTS | DAZN"
// → "BEIN SPORTS"), sorted, with the ungrouped ones last under "Other".
export function groupGenres(genres) {
  const map = new Map()
  for (const g of genres) {
    const i = String(g.name).indexOf('|')
    const group = i === -1 ? 'Other' : g.name.slice(0, i).trim()
    if (!map.has(group)) map.set(group, [])
    map.get(group).push(g)
  }
  return [...map.entries()].sort(([a], [b]) => {
    if (a === 'Other') return 1
    if (b === 'Other') return -1
    return a.localeCompare(b)
  })
}

// The Live TV and Movies & Series categories that hidden "languages" (the
// older filter: everything whose name starts with one) cover right now.
export function convertLanguages(languages, genreNames, vodTitles) {
  const hidden = new Set((languages ?? []).map(languageOf).filter(Boolean))
  if (hidden.size === 0) return { genres: [], vodCategories: [] }
  return {
    genres: genreNames.filter((n) => hidden.has(languageOf(n))),
    vodCategories: vodTitles.filter((t) => hidden.has(languageOf(t))),
  }
}

// An older filter hid whole "languages" — everything whose name starts with
// one (lib/languages.js) — and still does, so categories the portal adds later
// stay hidden too. Showing a category such a language hides drops that
// language, and hides everything else it covered one by one, so only what was
// asked for comes back. `oldLanguages` holds languageOf() values. Returns
// { languages (what's left), hideGenres, hideVod }, or null when no old
// language is involved.
export function releaseLanguages(showing, oldLanguages, genreNames, vodTitles) {
  const dropping = new Set(showing.map(languageOf).filter((l) => oldLanguages.has(l)))
  if (dropping.size === 0) return null
  const shown = new Set(showing.map(titleKey))
  const covered = convertLanguages([...dropping], genreNames, vodTitles)
  return {
    languages: [...oldLanguages].filter((l) => !dropping.has(l)),
    hideGenres: covered.genres.filter((n) => !shown.has(titleKey(n))),
    hideVod: covered.vodCategories.filter((t) => !shown.has(titleKey(t))),
  }
}
