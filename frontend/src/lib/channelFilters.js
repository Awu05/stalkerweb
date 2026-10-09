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

// The old Languages row hid everything whose name started with a "language".
// It becomes the Live TV and Movies & Series categories that matched, so
// nothing a viewer hid comes back.
export function convertLanguages(languages, genreNames, vodTitles) {
  const hidden = new Set((languages ?? []).map(languageOf).filter(Boolean))
  if (hidden.size === 0) return { genres: [], vodCategories: [] }
  return {
    genres: genreNames.filter((n) => hidden.has(languageOf(n))),
    vodCategories: vodTitles.filter((t) => hidden.has(languageOf(t))),
  }
}
