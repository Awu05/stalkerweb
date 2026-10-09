'use strict';

// Which viewer a request is for (docs/superpowers/specs/2026-10-08-viewer-profiles-design.md).
// First match wins: the X-Viewer header (the website), ?viewer=<id> (playlist
// and guide links), a /v/<id>/ path segment (Stremio, which appends its own
// paths to the addon URL), the Xtream username, else the default viewer.
//
// A viewer that no longer exists is never quietly swapped for the default one
// where that would show someone else's channels:
//   • a link naming it (?viewer=, /v/) is refused — refuseDeletedLinks, mounted
//     after the access gate so it reveals nothing to strangers;
//   • the website's X-Viewer is marked req.viewerGone, and the routes holding a
//     viewer's own data answer 409 so the website asks who is watching.
// Old links and apps that name no viewer get the default, as before.
//
// The viewer is looked up only when something asks — req.viewer, or current()
// from code without the request (lib/catalog.js, appState.getExportFilter) —
// so stream segments and images never touch the viewers file. It is kept in an
// AsyncLocalStorage for the rest of the request. Must run after the body
// parsers: their stream callbacks would otherwise run outside its context.

const { AsyncLocalStorage } = require('node:async_hooks');

const XTREAM_API = /^\/(?:player_api|get|xmltv|panel_api)\.php$/i;

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function createViewerContext(viewers) {
  const als = new AsyncLocalStorage();

  // The request's viewer, resolved once on first use.
  function resolver(req, fromPath) {
    let done = null;
    return () => {
      if (done) return done;
      const header = req.get('x-viewer');
      const query  = typeof req.query?.viewer === 'string' ? req.query.viewer : null;
      let viewer = null;
      for (const id of [header, query, fromPath]) {
        viewer = id ? viewers.get(String(id)) : null;
        if (viewer) break;
      }
      if (!viewer && XTREAM_API.test(req.path)) viewer = viewers.findByName(req.query?.username ?? req.body?.username);
      viewer ??= viewers.getDefault();
      done = {
        viewer,
        gone: !!header && !viewers.get(String(header)),
        // The Stremio addon's identity follows the link (/v/<id>/), so it never
        // changes under an installed addon.
        inPath: !!fromPath && viewer.id === fromPath,
      };
      return done;
    };
  }

  function middleware(req, res, next) {
    let fromPath = null;
    const m = /^\/v\/([^/?#]+)(.*)$/i.exec(req.url);
    if (m) {
      fromPath = decode(m[1]);
      req.url = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
      req.originalUrl = req.url;
    }
    req.viewerFromPath = fromPath;
    const resolve = resolver(req, fromPath);
    Object.defineProperties(req, {
      viewer:       { get: () => resolve().viewer, configurable: true },
      viewerGone:   { get: () => resolve().gone, configurable: true },
      viewerInPath: { get: () => resolve().inPath, configurable: true },
    });
    als.run(resolve, () => next());
  }

  // A playlist, guide or addon link naming a viewer that was deleted: refuse it
  // rather than serve the default viewer's channels (which may show adult ones).
  function refuseDeletedLinks(req, res, next) {
    const query = typeof req.query?.viewer === 'string' ? req.query.viewer : null;
    const named = req.viewerFromPath ?? query;
    if (!named || viewers.get(String(named))) return next();
    res.status(404).type('text/plain').send('The viewer this link belongs to was deleted. Copy a new link from the StalkerWeb Settings.');
  }

  return {
    middleware,
    refuseDeletedLinks,
    current: () => als.getStore()?.().viewer ?? null,
  };
}

module.exports = { createViewerContext };
