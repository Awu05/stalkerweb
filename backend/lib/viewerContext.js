'use strict';

// Which viewer a request is for (docs/superpowers/specs/2026-10-08-viewer-profiles-design.md).
// First match wins: the X-Viewer header (the website), ?viewer=<id> (playlist
// and guide links), a /v/<id>/ path segment (Stremio, which appends its own
// paths to the addon URL), the Xtream username, else the default viewer. An
// unknown id is never an error — old links and the Android app get the default.
//
// The viewer is kept in an AsyncLocalStorage for the rest of the request, so
// code without the request (lib/catalog.js, appState.getExportFilter) can ask
// for it. Must run after the body parsers: their stream callbacks would
// otherwise run outside the request's context.

const { AsyncLocalStorage } = require('node:async_hooks');

const XTREAM_API = /^\/(?:player_api|get|xmltv|panel_api)\.php$/i;

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function createViewerContext(viewers) {
  const als = new AsyncLocalStorage();

  function pick(req, fromPath) {
    const header = req.get('x-viewer');
    const query  = typeof req.query?.viewer === 'string' ? req.query.viewer : null;
    for (const id of [header, query, fromPath]) {
      const v = id ? viewers.get(String(id)) : null;
      if (v) return v;
    }
    if (XTREAM_API.test(req.path)) {
      const v = viewers.findByName(req.query?.username ?? req.body?.username);
      if (v) return v;
    }
    return viewers.getDefault();
  }

  function middleware(req, res, next) {
    let fromPath = null;
    const m = /^\/v\/([^/?#]+)(.*)$/i.exec(req.url);
    if (m) {
      fromPath = decode(m[1]);
      req.url = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
      req.originalUrl = req.url;
    }
    const viewer = pick(req, fromPath);
    req.viewer = viewer;
    // Whether the link itself names this viewer (/v/<id>/) — the Stremio addon's
    // identity follows the link, so it never changes under an installed addon.
    req.viewerInPath = !!fromPath && viewer.id === fromPath;
    // The website names its viewer in X-Viewer; one that no longer exists was
    // deleted on another device. Routes that would otherwise read or change the
    // default viewer's data in its place refuse instead (VIEWER_GONE).
    const named = req.get('x-viewer');
    req.viewerGone = !!named && !viewers.get(String(named));
    als.run(viewer, () => next());
  }

  return { middleware, current: () => als.getStore() ?? null };
}

module.exports = { createViewerContext };
