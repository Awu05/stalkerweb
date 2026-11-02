'use strict';

// The portal session's life: the idle auto-disconnect, the wake, and the
// auto-connect at startup.
//
// The idle timeout (no stream or proxy activity for idleTimeoutMs) drops the
// session and leaves the server *asleep* (appState.asleep) when there is a
// portal to wake to: the next real use — a data request through the session
// guard (middleware/session.js), or an outside player (stream links,
// playlists, Xtream, Stremio, recordings) — reconnects to the last portal that
// worked (config last_good) with ensureSession. The status route and anything
// a timer or poll sends (X-Background: 1) never do.
//
// `asleep` only drives what the apps show (and whether their data requests
// wake it). Outside players reconnect whenever there is a portal that worked
// and the user didn't disconnect on purpose (DELETE /api/auth/disconnect,
// saved as user_disconnected so a restart keeps it off) — after a failed
// Reconnect too.
//
// One connect at a time: a wake joins a connect already running
// (appState.connecting — the startup auto-connect, a manual Connect or
// Reconnect, a profile switch). A session re-authenticating is waited for a
// moment before it is replaced. A wake answers once the channel and genre
// lists are in (appState.channelsReady), or after listsWaitMs. A failed wake
// backs off for wakeRetryMs: until then it fails at once with the same reason
// (appState.wakeError).

const CacheManager = require('../cache/CacheManager');
const log = require('../logger');
const TAG = 'server';

const WAKE_RETRY_MS = 60_000;
const REAUTH_WAIT_MS = 15_000;
const LISTS_WAIT_MS = 60_000;

/** What a wake reconnects to: the last portal that worked, else (configs from before it was kept) the saved one. */
function wakeConfig(saved) {
  if (saved?.last_good?.portal && saved.last_good.mac) return saved.last_good;
  if (saved?.portal && saved?.mac) return saved;
  return null;
}

/** Whether there is something to reconnect to: a portal that worked, and no Disconnect on purpose. */
function wakeTarget(saved) {
  return saved?.user_disconnected ? null : wakeConfig(saved);
}

/**
 * Tears the portal session down — the idle disconnect, a connect replacing it,
 * a Disconnect. `asleep` given: whether the next use reconnects (and the last
 * wake's failure is forgotten); left out, unchanged.
 */
function dropSession(appState, { asleep } = {}) {
  appState.sessionManager?.destroy();
  appState.sessionManager = null;
  appState.client = null;
  appState.channelManager = null;
  appState.guideManager = null;
  appState.vodManager = null;
  appState.identity = null;
  appState.channelsReady = null;
  if (asleep !== undefined) {
    appState.asleep = asleep;
    appState.wakeError = null;
    appState.wakeRetryAt = 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installPortalSession(appState, {
  dataDir, idleTimeoutMs, now = () => Date.now(),
  wakeRetryMs = WAKE_RETRY_MS, reauthWaitMs = REAUTH_WAIT_MS, listsWaitMs = LISTS_WAIT_MS,
}) {
  const cache = new CacheManager(dataDir);
  const up = () => !!(appState.sessionManager?.isAuthenticated() && appState.channelManager);

  // The idle timeout: tear down the session — asleep if there is a portal to wake to.
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
    const asleep = !!wakeTarget(cache.load());
    log.info(TAG, `idle timeout (${appState.idleTimeoutMs / 60000}m) — disconnecting the portal session${asleep ? ' (asleep: the next use reconnects)' : ''}`);
    dropSession(appState, { asleep });
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
    if (e.cancelled) return;   // a Disconnect, not a failure
    appState.wakeError = e.message;
    appState.wakeRetryAt = now() + wakeRetryMs;
    log.error(TAG, `reconnect failed: ${e.message} — trying again on use after ${wakeRetryMs / 1000}s`);
  }

  // The first channel/genre load after a connect, waited for at most listsWaitMs.
  async function listsIn() {
    const ready = appState.channelsReady;
    if (!ready) return;
    let timer;
    await Promise.race([ready.catch(() => {}), new Promise((r) => { timer = setTimeout(r, listsWaitMs); })]);
    clearTimeout(timer);
  }

  // A session re-authenticating: wait for it a moment (or for it to go).
  async function reauthWait() {
    const until = Date.now() + reauthWaitMs;
    while (Date.now() < until) {
      const sm = appState.sessionManager;
      if (!sm || up() || appState.connecting) return;
      if (sm.lastError && !sm.isAuthenticating) return;   // its re-auth failed
      await sleep(Math.min(100, reauthWaitMs));
    }
  }

  // The connects running, one after another; the last one's failure, if any.
  async function joinConnecting() {
    let failure = null;
    while (appState.connecting) {
      try { await appState.connecting; } catch (e) { failure = e; }
    }
    return failure;
  }

  // Brings the session back for a request. Resolves true when connected (and
  // the first lists are in); throws when there is nothing to reconnect to, the
  // user disconnected, or it failed (then backing off).
  appState.ensureSession = async function ensureSession() {
    if (up()) return true;
    if (appState.sessionManager && !appState.connecting) {
      await reauthWait();
      if (up()) return true;
    }
    if (appState.connecting) {
      const failure = await joinConnecting();
      if (up()) {
        await listsIn();
        appState.touchActivity();
        return true;
      }
      throw failure || new Error('Not connected to a portal.');
    }
    // From here to connectPortal nothing waits: a second caller sees appState.connecting and joins.
    const saved = cache.load();
    if (saved?.user_disconnected) throw new Error('Disconnected — connect a portal first.');
    const target = wakeTarget(saved);
    if (!target) throw new Error('Not connected to a portal. Configure portal first.');
    if (appState.wakeError && now() < appState.wakeRetryAt) throw new Error(appState.wakeError);
    log.info(TAG, `no portal session — reconnecting to ${target.portal} for an incoming request`);
    try {
      await appState.connectPortal(target);   // replaces a session whose re-auth never came back
    } catch (e) {
      failedWake(e);
      throw e;
    }
    log.info(TAG, 'reconnected ✓');
    await listsIn();
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

module.exports = { installPortalSession, dropSession, wakeConfig, wakeTarget, WAKE_RETRY_MS };
