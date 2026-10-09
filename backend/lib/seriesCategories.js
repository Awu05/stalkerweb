'use strict';

// Where a portal keeps its TV shows. Most have a series section of their own;
// some have none and mix shows into the movie categories ("ENGLISH TV SHOWS",
// "NETFLIX ENGLISH SHOWS"). There, a movie category counts as a series one
// when its name says so — SHOW(S), SERIES or SEASON(S) as a word. "TV" alone
// doesn't ("APPLE TV+ ENGLISH MOVIES"), and a name that also says MOVIE(S) or
// FILM(S) ("ANIME MOVIES/SERIES") is listed under both. Reading every title to
// decide instead would take dozens of portal requests.
//
// Shared by the VOD page's categories (routes/vod.js) and the Xtream / Stremio
// catalog (lib/catalog.js), so all of them agree.

const { isAllCategory } = require('./vodCategoryFilter');

const SERIES_WORDS = /\b(?:SHOWS?|SERIES|SEASONS?)\b/i;
const MOVIE_WORDS  = /\b(?:MOVIES?|FILMS?)\b/i;
const NO_SERIES_RECHECK_MS = 30 * 60 * 1000;   // a portal that rejected type=series

/** { movies, series } from a movie section's categories, split by name. */
function splitByName(categories) {
  const series = [];
  const movies = [];
  for (const c of categories) {
    const showName = !isAllCategory(c) && SERIES_WORDS.test(c.title ?? '');
    if (showName) series.push(c);
    if (!showName || MOVIE_WORDS.test(c.title ?? '')) movies.push(c);
  }
  return { movies, series };
}

/**
 * The portal's movie and series categories: { movies, series, seriesType,
 * byName }. `seriesType` is the section series titles are read from ('series',
 * or 'vod' when the portal has none); `byName` says the series categories were
 * picked out of the movie ones by name. A portal that rejects type=series isn't
 * asked again for a while (remembered on the vodManager, one per connection).
 */
async function vodLayout(vodManager) {
  const movies = await vodManager.getCategories('vod');
  let series = [];
  if (!(vodManager._noSeriesUntil > Date.now())) {
    try {
      series = await vodManager.getCategories('series');
    } catch {
      vodManager._noSeriesUntil = Date.now() + NO_SERIES_RECHECK_MS;
    }
  }
  if (series.length) return { movies, series, seriesType: 'series', byName: false };
  const split = splitByName(movies);
  return split.series.length
    ? { movies: split.movies, series: split.series, seriesType: 'vod', byName: true }
    : { movies, series: [], seriesType: 'vod', byName: false };
}

module.exports = { splitByName, vodLayout };
