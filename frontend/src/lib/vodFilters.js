// Filters for the VOD page (genre, year, rating, recently added, HD, not
// watched yet), applied to a category's whole listing — the portal can only
// search and sort, so the page reads every title (/api/vod/listing) and
// filters them here.

export const NO_FILTERS = { genre: '', year: '', minRating: 0, addedDays: 0, hd: false, unwatched: false }

export const filtersActive = (f) =>
  !!(f.genre || f.year || f.minRating || f.addedDays || f.hd || f.unwatched)

// '2020s', '2010s' … '1980s', 'Older' for anything before 1980, or null.
export function decadeOf(year) {
  const y = parseInt(year, 10)
  if (!Number.isFinite(y) || y < 1900) return null
  return y < 1980 ? 'Older' : `${Math.floor(y / 10) * 10}s`
}

// The year filter holds a year ("2025") or, when a category spans many, a
// decade ("2010s", "Older").
const isDecade = (sel) => sel === 'Older' || /s$/.test(sel)
function yearMatches(item, sel) {
  if (isDecade(sel)) return decadeOf(item.year) === sel
  return String(parseInt(item.year, 10)) === sel
}

// "2026-10-05 10:00:00" (the portal's local time) → ms, or NaN.
const addedAt = (item) => Date.parse(String(item.added || '').replace(' ', 'T'))

const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })

export function sortVodItems(items, sort) {
  const list = [...items]
  if (sort === 'added') {
    // Newest first; titles without a date last, by name.
    return list.sort((a, b) => {
      const ta = addedAt(a), tb = addedAt(b)
      if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) - Number.isNaN(tb) || byName(a, b)
      return tb - ta
    })
  }
  return list.sort(byName)
}

/**
 * The titles that pass every filter. `watched` holds the ids of titles started
 * or finished (lib/vodProgress.js); `search` matches part of the name.
 */
export function applyVodFilters(items, f, { now = Date.now(), watched = new Set(), search = '' } = {}) {
  const q = search.trim().toLowerCase()
  const since = f.addedDays ? now - f.addedDays * 24 * 60 * 60 * 1000 : null
  return items.filter((item) => {
    if (q && !String(item.name).toLowerCase().includes(q)) return false
    if (f.genre && !(item.genres ?? []).includes(f.genre)) return false
    if (f.year && !yearMatches(item, f.year)) return false
    if (f.minRating && !(item.rating >= f.minRating)) return false
    if (since !== null && !(addedAt(item) >= since)) return false
    if (f.hd && !item.isHD) return false
    if (f.unwatched && watched.has(String(item.id))) return false
    return true
  })
}

const DECADE_ORDER = (d) => (d === 'Older' ? -1 : parseInt(d, 10))

// Up to this many different years, the year filter lists each one; more, and
// it lists decades instead.
const MAX_SINGLE_YEARS = 12

// What the titles offer: genres and years (or decades) present, and whether
// any carry a rating or an HD flag — a filter with nothing to pick isn't shown.
export function filterOptions(items) {
  const genres = new Set()
  const years = new Set()
  const decades = new Set()
  let hasRating = false
  let hasHD = false
  for (const item of items) {
    for (const g of item.genres ?? []) genres.add(g)
    const d = decadeOf(item.year)
    if (d) { decades.add(d); years.add(String(parseInt(item.year, 10))) }
    if (item.rating > 0) hasRating = true
    if (item.isHD) hasHD = true
  }
  return {
    genres: [...genres].sort((a, b) => a.localeCompare(b)),
    years: years.size <= MAX_SINGLE_YEARS
      ? [...years].sort((a, b) => b - a)
      : [...decades].sort((a, b) => DECADE_ORDER(b) - DECADE_ORDER(a)),
    hasRating,
    hasHD,
  }
}
