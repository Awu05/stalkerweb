// middleware/session.js
// Attaches the active Stalker session to every request as req.session.
// Returns 503 if the portal is not connected.
//
// Real use brings the session back: asleep (the idle timeout dropped it), a
// connect running, or a session re-authenticating — the request waits for
// appState.ensureSession (lib/portalSession.js) and goes on. What a timer or
// a poll sends never does, or the session would never go idle: the apps mark
// every such request with the X-Background: 1 header (one rule, in their
// fetch helpers), and the event streams, which can't send headers, pass
// { wake: false }.

'use strict';

const up = (appState) => !!appState.sessionManager?.isAuthenticated();

module.exports = function sessionMiddleware(appState, { wake = true } = {}) {
  return async function (req, res, next) {
    if (!up(appState)) {
      const background = !wake || req.get('X-Background') === '1';
      if (!background && (appState.sessionManager || appState.asleep || appState.connecting) && appState.ensureSession) {
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
