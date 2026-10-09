'use strict';

// Which movie & series categories a viewer sees (Settings → My channels →
// Movies & Series). Categories are hidden by name, compared without case or
// stray spaces, so a movie and a series category with the same name go
// together. A hidden-languages list from before (lib/languages.js) is still
// honoured until that viewer's Settings converts it into categories.

const { isLanguageDisabled } = require('./languages');

const ALL_CATEGORIES_ID = '*';   // the portal's "everything" pseudo-category

const titleKey = (title) => String(title ?? '').trim().toUpperCase();

/**
 * The portal's catch-all category: id "*" on most portals, but some give it an
 * ordinary id and call it "All". The one rule for it — the catalog and the
 * website's lists follow the same.
 */
function isAllCategory(c) {
  return String(c?.id) === ALL_CATEGORIES_ID || titleKey(c?.title) === 'ALL';
}

/** A comparison-ready Set from a viewer's stored list. */
function toCategorySet(list) {
  return new Set((Array.isArray(list) ? list : []).map(titleKey).filter(Boolean));
}

/**
 * The categories left to show. Whenever anything is hidden, the portal's "All"
 * pseudo-category goes too: its titles carry no category, so it would let every
 * hidden one straight back in through one tap.
 */
function visibleVodCategories(categories, { hiddenCategories = new Set(), hiddenLanguages = new Set() } = {}) {
  if (hiddenCategories.size === 0 && hiddenLanguages.size === 0) return categories;
  return categories.filter((c) =>
    !isAllCategory(c) &&
    !hiddenCategories.has(titleKey(c.title)) &&
    !isLanguageDisabled(c.title, hiddenLanguages));
}

module.exports = { visibleVodCategories, toCategorySet, titleKey, isAllCategory, ALL_CATEGORIES_ID };
