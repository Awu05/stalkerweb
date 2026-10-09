'use strict';

// The channel filters for whoever is asking: the current viewer's hidden genres
// and languages and Show Adult (lib/viewerContext.js), or the default viewer's
// outside a request. Installed on appState so the exports, the Xtream API, the
// Stremio addon and the VOD category list (all of which call these hooks)
// follow the viewer without knowing about viewers.

const { buildExportFilter } = require('./exportFilter');
const { toLanguageSet } = require('./languages');
const { toCategorySet } = require('./vodCategoryFilter');

function installViewerFilters(appState, { viewers, context }) {
  const current = () => context.current() ?? viewers.getDefault();
  appState.currentViewer      = current;
  appState.isDefaultViewer    = (v) => !!v && v.id === viewers.getDefault()?.id;
  appState.getExportFilter    = () => {
    const v = current();
    return buildExportFilter({ profile: v, showAdult: v?.showAdult === true });
  };
  appState.getShowAdult       = () => current()?.showAdult === true;
  appState.getHiddenLanguages = () => toLanguageSet(current()?.disabledLanguages);
  appState.getHiddenVodCategories = () => toCategorySet(current()?.disabledVodCategories);
}

module.exports = { installViewerFilters };
