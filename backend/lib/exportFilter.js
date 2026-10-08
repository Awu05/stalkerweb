'use strict';

// Which channels the M3U / XMLTV / XSPF exports include.
//
// The exports follow the same filters as the web channel list, so a client
// like Jellyfin — which has no channel grouping and lists every channel it is
// given — only receives the categories the user actually watches:
//   • genres hidden in the active profile (Settings → Genre Filters)
//   • languages hidden in the active profile
//   • adult channels, unless "Show Adult Content" is on
// Channels without a genre are kept, as in the web UI.

const { isLanguageDisabled, toLanguageSet } = require('./languages');

// Mirrors frontend/src/lib/adultFilter.js — keep the two lists in step.
const ADULT_PATTERNS = ['adult', 'for adults', 'xxx', '18+', 'erotic', 'erotica', 'hentai', 'porn', 'sexy', 'nsfw'];

function isAdult(name) {
  const lower = String(name ?? '').toLowerCase();
  return ADULT_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Builds the export filter for a profile and the app settings.
 * Returns { keep(channel) → boolean, key } where `key` changes whenever the
 * filter does, so callers can cache filtered output.
 */
function buildExportFilter({ profile = null, showAdult = false } = {}) {
  const genres    = new Set(Array.isArray(profile?.disabledGenres) ? profile.disabledGenres : []);
  const languages = toLanguageSet(profile?.disabledLanguages);

  const keep = (ch) => {
    if (!showAdult && (isAdult(ch.genre) || isAdult(ch.name))) return false;
    if (!ch.genre) return true;
    if (genres.has(ch.genre)) return false;
    if (isLanguageDisabled(ch.genre, languages)) return false;
    return true;
  };

  const key = JSON.stringify([showAdult, [...genres].sort(), [...languages].sort()]);
  return { keep, key };
}

const KEEP_ALL = { keep: () => true, key: 'all' };

/**
 * The filter for an export request. `?all=1` opts out and returns every
 * channel; otherwise the app's current filter (appState.getExportFilter), or
 * no filtering when none is configured.
 */
function exportFilterFor(req, appState) {
  if (req.query?.all === '1') return KEEP_ALL;
  return appState?.getExportFilter?.() ?? KEEP_ALL;
}

module.exports = { buildExportFilter, exportFilterFor, isAdult };
