// middleware/session.js
// Attaches the active Stalker session to every request as req.session.
// Returns 503 if the portal is not connected.
//
// Asleep (the idle timeout dropped the session) or a connect running: real
// use wakes it — the request waits for the reconnect to the last portal that
// worked (appState.ensureSession, lib/portalSession.js) and goes on. The apps'
// polling never wakes it, or the session would never go idle: routes only ever
// polled pass { wake: false }, and the apps mark their timed refreshes with
// the X-Background: 1 header.

'use strict';

const up = (appState) => !!appState.sessionManager?.isAuthenticated();

module.exports = function sessionMiddleware(appState, { wake = true } = {}) {
  return async function (req, res, next) {
    if (!up(appState)) {
      const background = !wake || req.get('X-Background') === '1';
      // A SessionManager still there is re-authenticating — never replaced from here.
      if (!background && !appState.sessionManager && (appState.asleep || appState.connecting) && appState.ensureSession) {
        try {
          await appState.ensureSession();
        } catch (e) {
          return res.status(503).json({ error: `Couldn't reconnect to the portal: ${e.message}`, wakeError: e.message });
        }
      }
    }
    if (!up(appState)) {
      return res.status(503).json({
        error: 'Not connected to a portal. POST /api/auth/connect first.',
        ...(appState.asleep && appState.wakeError ? { wakeError: appState.wakeError } : {}),
      });
    }
    req.stalker = appState;  // expose { client, sessionManager, channelManager, guideManager }
    next();
  };
};
