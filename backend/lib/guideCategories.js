'use strict';

// Standard programme categories for the XMLTV guide.
//
// Jellyfin's Live TV "Programs" page has Movies, Sports, Kids and News rows,
// filled from each programme's <category>. It compares categories exactly
// (ignoring case) against its lists — by default "movie", "sports",
// "kids"/"children"/"family", "news" and a few more — so a portal genre like
// "ENGLISH | KIDS" or "USA SPORTS" matches nothing. This turns a genre, or the
// portal's own category for a programme, into those words.
//
// Only genre and category text are used, never channel names: a name says
// little about what a programme is (HBO mostly airs series, "Transport TV"
// is not sport), and guessing from it put programmes in the wrong rows.
//
// Matching is by whole words. Text is lower-cased, accents are dropped
// ("Cinéma" → cinema), and a word is split where letters meet digits, so
// "News18" and "NEWS24" read as "news", "Film4" as "film".

const WORDS = {
  News:   ['news', 'noticias', 'nachrichten', 'actualites', 'notizie', 'nieuws'],
  Sports: ['sport', 'sports', 'deportes', 'football', 'soccer', 'futbol', 'basketball', 'baseball',
           'hockey', 'tennis', 'golf', 'cricket', 'rugby', 'racing', 'motorsport', 'motorsports',
           'boxing', 'ufc', 'wwe', 'nba', 'nfl', 'nhl', 'mlb', 'f1'],
  Kids:   ['kids', 'kid', 'children', 'childrens', 'child', 'cartoon', 'cartoons', 'junior',
           'infantil', 'enfants', 'kinder', 'bambini'],
  Movie:  ['movie', 'movies', 'cinema', 'cine', 'film', 'films', 'filme', 'peliculas', 'pelicula', 'kino'],
};
const ORDER = ['News', 'Sports', 'Kids', 'Movie'];
const LOOKUP = new Map(ORDER.flatMap((name) => WORDS[name].map((w) => [w, name])));

function words(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // drop accents
    .toLowerCase()
    .replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4')    // News18 → news 18
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The standard categories a genre or programme category points to, in a fixed
 * order. Empty when nothing matches.
 * @param {string|null|undefined} text
 * @returns {string[]} e.g. ['Kids']
 */
function standardCategories(text) {
  const found = new Set();
  for (const w of words(text)) {
    const name = LOOKUP.get(w);
    if (name) found.add(name);
  }
  return ORDER.filter((name) => found.has(name));
}

module.exports = { standardCategories };
