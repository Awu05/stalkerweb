'use strict';

// The portal session's life: the idle auto-disconnect, the wake, and the
// auto-connect at startup.
//
// The idle timeout (no stream or proxy activity for idleTimeoutMs) drops the
// session and leaves the server *asleep* (appState.asleep): the next real use
// — a data request through the session guard (middleware/session.js), or an
// outside player (stream links, playlists, Xtream, Stremio, recordings) —
// reconnects to the last portal that worked (config last_good) with
// ensureSession. The status route and the apps' polling never do.
//
// Not asleep: disconnected on purpose (DELETE /api/auth/disconnect, saved as
// user_disconnected so a restart keeps it off), or a connect the user started
// failed (routes/auth.js). Nothing reconnects behind the user's back then.
//
// One connect at a time: a wake joins a connect already running
// (appState.connecting — the startup auto-connect, a manual Connect or
// Reconnect, a profile switch). A failed wake backs off for wakeRetryMs: until
// then a wake fails at once with the same reason (appState.wakeError).

const CacheManager = require('../cache/CacheManager');
const log = require('../logger');
const TAG = 'server';

const WAKE_RETRY_MS = 60_000;

/** What a wake reconnects to: the last portal that worked, else (configs from before it was kept) the saved one. */
function wakeConfig(saved) {
  if (saved?.last_good?.portal && saved.last_good.mac) return saved.last_good;
  if (saved?.portal && saved?.mac) return saved;
  return null;
}

function installPortalSession(appState, { dataDir, idleTimeoutMs, now = () => Date.now(), wakeRetryMs = WAKE_RETRY_MS }) {
  const cache = new CacheManager(dataDir);

  // The idle timeout: tear down the session — asleep, a use wakes it.
  function idleDisconnect() {
    appState._idleTimer = null;
    if (!appState.sessionManager || !appState.idleTimeoutMs) return;
    // Never tear down while a stream connection is still open — playback is live.
    // Defer the check by one idle interval so the timer resumes once it closes.
    if (appState.activeStreams > 0) {
      log.debug(TAG, `idle timeout reached but ${appState.activeStreams} stream(s) active — deferring disconnect`);
      appState._idleTimer = setTimeout(idleDisconnect, appState.idleTimeoutMs);
      return;
    }
    log.info(TAG, `idle timeout (${appState.idleTimeoutMs / 60000}m) — disconnecting the portal session (asleep: the next use reconnects)`);
    appState.sessionManager.destroy();
    appState.sessionManager = null;
    appState.client = null;
    appState.channelManager = null;
    appState.guideManager = null;
    appState.vodManager = null;
    appState.identity = null;
    appState.asleep = true;
    appState.wakeError = null;
    appState.wakeRetryAt = 0;
  }

  // (Re)arm the disconnect timer so it fires idleTimeoutMs after the last
  // activity — counting from lastActivityAt, so changing the timeout mid-session
  // keeps the elapsed idle time instead of restarting the countdown.
  function armIdleTimer() {
    clearTimeout(appState._idleTimer);
    appState._idleTimer = null;
    if (!appState.idleTimeoutMs) return;   // 0 = never
    const idleFor = appState.lastActivityAt ? now() - Date.parse(appState.lastActivityAt) : 0;
    appState._idleTimer = setTimeout(idleDisconnect, Math.max(0, appState.idleTimeoutMs - idleFor));
  }

  appState.idleTimeoutMs  = idleTimeoutMs;
  appState.lastActivityAt = null;
  appState._idleTimer     = null;
  appState.activeStreams  = 0;      // open proxy stream connections (playback in progress)
  appState.asleep         = false;
  appState.wakeError      = null;
  appState.wakeRetryAt    = 0;

  // Applies a timeout saved from the Settings page immediately — no restart.
  appState.setIdleTimeoutMinutes = function setIdleTimeoutMinutes(minutes) {
    appState.idleTimeoutMs = minutes * 60 * 1000;
    log.info(TAG, minutes ? `idle timeout set to ${minutes}m` : 'idle auto-disconnect disabled');
    if (appState.sessionManager) armIdleTimer();
  };

  function failedWake(e) {
    appState.wakeError = e.message;
    appState.wakeRetryAt = now() + wakeRetryMs;
    log.error(TAG, `reconnect failed: ${e.message} — trying again on use after ${wakeRetryMs / 1000}s`);
  }

  // Brings the session back for a request: joins a connect already running,
  // else wakes the server if it is asleep. Never while a SessionManager exists
  // (re-authenticating: its auth checker brings it back). Resolves true when
  // connected; throws when there is nothing to reconnect to, or it failed.
  appState.ensureSession = async function ensureSession() {
    const sm = appState.sessionManager;
    if (sm) {
      if (sm.isAuthenticated() && appState.channelManager) return true;
      throw new Error('The portal session is re-authenticating — try again in a moment.');
    }
    if (appState.connecting) {
      let failure = null;
      while (appState.connecting) {
        try { await appState.connecting; } catch (e) { failure = e; }
      }
      if (appState.sessionManager?.isAuthenticated()) return true;
      throw failure || new Error('Not connected to a portal.');
    }
    if (!appState.asleep) throw new Error('Not connected to a portal. Configure portal first.');
    if (appState.wakeError && now() < appState.wakeRetryAt) throw new Error(appState.wakeError);
    const target = wakeConfig(cache.load());
    if (!target) throw new Error('Not connected to a portal. Configure portal first.');
    log.info(TAG, `asleep — reconnecting to ${target.portal} for an incoming request`);
    try {
      await appState.connectPortal(target);
    } catch (e) {
      failedWake(e);
      throw e;
    }
    log.info(TAG, 'reconnected ✓');
    appState.touchActivity();
    return true;
  };

  appState.touchActivity = function touchActivity() {
    appState.lastActivityAt = new Date(now()).toISOString();
    armIdleTimer();
  };

  // At startup: connect to the last portal that worked — unless the user
  // disconnected. Asleep while it runs, so a failure (the network not up yet)
  // leaves it to the next use, after the back-off.
  async function autoConnect() {
    const saved = cache.load();
    if (saved?.user_disconnected) {
      log.info(TAG, 'disconnected by the user — not auto-connecting');
      return;
    }
    const target = wakeConfig(saved);
    if (!target) {
      log.info(TAG, 'no saved portal config — waiting for POST /api/auth/connect');
      return;
    }
    log.info(TAG, `auto-connecting to ${target.portal} (${target.mac})`);
    appState.asleep = true;
    try {
      await appState.connectPortal(target);
      log.info(TAG, 'auto-connect: session established ✓');
      appState.touchActivity();
    } catch (e) {
      if (appState.asleep) failedWake(e);
      else log.error(TAG, `auto-connect failed: ${e.message}`);
    }
  }

  return { idleDisconnect, armIdleTimer, autoConnect };
}

module.exports = { installPortalSession, wakeConfig, WAKE_RETRY_MS };
