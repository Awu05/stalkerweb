'use strict';

// Standard programme categories for the XMLTV guide.
//
// Jellyfin's Live TV "Programs" page has Movies, Sports, Kids and News rows,
// filled from each programme's <category>. It only recognises exact words —
// by default "movie", "sports", "kids"/"children"/"family", "news" — so a
// portal genre like "ENGLISH | KIDS" or "USA SPORTS" matches nothing. This
// maps a channel's genre, the portal's own programme category and the channel
// name onto those words.

const RULES = [
  ['News',   /\bnews\b|\bcnn\b|\bmsnbc\b|\bcnbc\b|\bbbc world\b|\bsky news\b|\bal jazeera\b/i],
  ['Sports', /sport|football|soccer|\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bufc\b|\bwwe\b|boxing|tennis|\bgolf\b|cricket|rugby|racing|\bf1\b|\bespn\b|\bdazn\b|\bbein\b/i],
  ['Kids',   /\bkids?\b|child|cartoon|junior|\bjr\b|\bdisney\b|nickelodeon|\bnick\b|\bnick jr\b|boomerang|cbeebies|\bbaby\b|toon/i],
  ['Movie',  /movie|cinema|\bfilms?\b|\bkino\b|\bcine\b|\bhbo\b|cinemax|showtime|starz|\bamc\b|\btcm\b/i],
];

/**
 * The standard categories that apply, in a fixed order.
 * @param {...(string|null|undefined)} texts  genre name, programme category, channel name…
 * @returns {string[]} e.g. ['Kids'] — empty when nothing matches
 */
function standardCategories(...texts) {
  const text = texts.filter(Boolean).join(' ');
  if (!text) return [];
  return RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

module.exports = { standardCategories };
