// routes/auth.js
// POST   /api/auth/connect          — initialise portal connection
// GET    /api/auth/status           — check session state
// GET    /api/auth/config           — return saved config for WebUI pre-fill
// DELETE /api/auth/disconnect       — tear down session
// POST   /api/auth/reconnect        — re-connect using saved config

'use strict';

const express = require('express');
const { StalkerClient } = require('../stalker/StalkerClient');
const SessionManager = require('../stalker/SessionManager');
const ChannelManager = require('../stalker/ChannelManager');
const GuideManager   = require('../stalker/GuideManager');
const VodManager     = require('../stalker/VodManager');
const { createIdentity } = require('../stalker/identity');
const { DEVICE_PROFILE } = require('../stalker/deviceProfile');
const CacheManager = require('../cache/CacheManager');
const log = require('../logger');
const rateLimit = require('express-rate-limit');
const { connectRules } = require('../middleware/validate');
const { dropSession } = require('../lib/portalSession');
const TAG = 'auth';

// Rate limiters
const connectLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: { error: 'Too many connect attempts. Try again in 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const reconnectLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: { error: 'Too many reconnect attempts. Try again in 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Ensure portal URL always ends with /c/
function normalizePortal(url) {
  return String(url).trim().replace(/\/c\/?$/, '').replace(/\/?$/, '') + '/c/';
}

// A connection's fields: what PUT /config saves, and what is remembered as the
// last portal that worked (last_good) — everything a wake needs to reconnect,
// the password included (kept in config.json, as profiles.json keeps the
// profiles' — never logged, never sent back).
const CONNECTION_FIELDS = ['portal', 'mac', 'timezone', 'lang', 'login', 'password',
  'serial_number', 'device_id', 'device_id2', 'send_device_id', 'send_device_id2',
  'signature', 'portal_signature', 'connection_timeout'];

function lastGoodFrom(body) {
  const kept = {};
  for (const key of CONNECTION_FIELDS) if (body[key] !== undefined) kept[key] = body[key];
  kept.portal = normalizePortal(body.portal);
  return kept;
}

/** Whether a saved portal + MAC is the connection last_good remembers. */
function isLastGood(portal, mac, good) {
  return !!(good && portal && normalizePortal(portal) === good.portal && mac === good.mac);
}

// connectOnce: tests replace the portal handshake (connectPortalOnce).
module.exports = function authModule(appState, config, { connectOnce } = {}) {
  const router = express.Router();
  const cache = new CacheManager(config.dataDir);

  // ── Shared connect logic ───────────────────────────────────────────────────
  async function connectPortalOnce(body) {
    const {
      portal,
      mac,
      timezone,
      lang,
      login,
      password,
      token,
      serial_number,
      device_id,
      device_id2,
      send_device_id,
      send_device_id2,
      signature,
      portal_signature,
      connection_timeout,
    } = body;

    if (!portal) throw new Error('portal URL is required');
    if (!mac)    throw new Error('MAC address is required');

    const portalUrl = normalizePortal(portal);
    log.info(TAG, `connectPortal: portal=${portalUrl} mac=${mac} timezone=${timezone || 'Europe/London'}`);

    // Tear down existing session
    if (appState.sessionManager) {
      log.info(TAG, 'tearing down existing session');
      dropSession(appState);
    }

    // Resolve token: prefer the stalker_HASH entry saved for this portal over
    // any token passed in the request body — the saved one is the most recent.
    const savedToken = cache.getToken(portalUrl);
    const resolvedToken = savedToken || token || '';
    log.info(TAG, `token resolution: passed=${token || '(none)'}  saved=${savedToken || '(none)'}  using=${resolvedToken || '(none)'}`);

    // Resolve portal_signature: user-entered value wins, then saved config value.
    const existing = cache.load() || {};
    const savedPortalSig = existing.portal_signature || '';
    const resolvedPortalSig = (portal_signature || '').trim() || savedPortalSig;
    if (resolvedPortalSig) {
      log.info(TAG, `portal_signature: entered=${portal_signature || '(none)'}  saved=${savedPortalSig || '(none)'}  using=${resolvedPortalSig}`);
    }

    const identity = createIdentity({
      mac,
      lang: lang || 'en',
      time_zone: timezone || 'Europe/London',
      token: resolvedToken,
      // Treat a saved/passed token as valid going in, so the first get_profile
      // sends not_valid_token=0 (handshake will correct this if the portal
      // disagrees). A fresh connect with no token stays not_valid=1.
      valid_token: !!resolvedToken,
      login: login || '',
      password: password || '',
      serial_number: serial_number || '0000000000000',
      device_id: device_id || '',
      device_id2: device_id2 || '',
      // STBEmu can carry a populated device_id/device_id2 that it never
      // actually sends to the portal (send_device_id: false in the backup) —
      // respect that so we don't send an ID the portal never associated with
      // this account. Default true when unset (manual profiles, old configs).
      send_device_id: send_device_id !== false,
      send_device_id2: send_device_id2 !== false,
      signature: signature || '',
      portal_signature: resolvedPortalSig,
    });

    const client = new StalkerClient();
    client.setIdentity(identity);
    client.setTimeout(connection_timeout || 10);

    log.info(TAG, `initialising client for ${portalUrl}`);
    await client.initialize(portalUrl);

    const sessionManager = new SessionManager(client);
    sessionManager.setIdentity(identity, !!resolvedToken);
    sessionManager.setStatusCallback((status) => {
      log.info(TAG, `session status → ${status}`);
    });
    // Persist any token the portal rotates mid-session (watchdog re-auth, the
    // 30s auth-checker, etc.) so a restart reconnects with the live token rather
    // than the stale one captured at first connect.
    sessionManager.setTokenPersistCallback((newToken) => {
      cache.saveToken(portalUrl, newToken);
    });

    const channelManager = new ChannelManager(client, config.dataDir);
    const guideManager   = new GuideManager(client, `${config.dataDir}/cache`);
    const vodManager     = new VodManager(client);

    // Persist config before auth so settings survive a failed attempt or restart.
    // Spread existing config first so stalker_HASH token entries are preserved.
    const configToSave = {
      ...existing,
      portal: portalUrl, mac,
      timezone: timezone || 'Europe/London',
      lang: lang || 'en',
      login: login || '',
      serial_number: serial_number || '0000000000000',
      device_id: device_id || '',
      device_id2: device_id2 || '',
      send_device_id: send_device_id !== false,
      send_device_id2: send_device_id2 !== false,
      signature: signature || '',
      connection_timeout: connection_timeout || 10,
      token: resolvedToken,
    };
    cache.save(configToSave);

    log.info(TAG, 'authenticating…');
    await sessionManager.authenticate();
    log.info(TAG, `authenticated ✓  token=${identity.token}`);

    // Persist token under stalker_HASH (STBEmu-compatible) and legacy field.
    if (identity.token) {
      cache.saveToken(portalUrl, identity.token);
    }

    // Persist portal_signature if the portal returned one during auth.
    if (identity.portal_signature) {
      cache.savePortalSignature(identity.portal_signature);
    }

    appState.client = client;
    appState.sessionManager = sessionManager;
    appState.channelManager = channelManager;
    appState.guideManager   = guideManager;
    appState.vodManager     = vodManager;
    appState.identity = identity;

    // A wake answers once these are in (lib/portalSession.js, appState.channelsReady).
    log.info(TAG, 'starting background channel/group pre-load');
    appState.channelsReady = Promise.all([
      channelManager.loadChannels(),
      channelManager.loadGroups(),
    ]).then(() => {
      log.info(TAG, 'background channel/group load complete');
    }).catch((e) => {
      log.error(TAG, `background channel/group load failed: ${e.message}`);
    });

    return {
      token: identity.token,
      profile: sessionManager.getProfile(),
    };
  }

  // Serializes every connectPortal() call — manual /connect, /reconnect, the
  // startup auto-connect and the wake (appState.connectPortal, the same
  // function reference returned below) all funnel through this queue. Without
  // it, two concurrent connects each build their own SessionManager/watchdog/
  // auth-check timers; whichever finishes last wins and the loser's session is
  // never destroyed — its timers keep pinging the portal forever.
  //
  // appState.connecting is the connect running (or queued) — a wake joins it
  // instead of starting another (lib/portalSession.js). A success is the last
  // portal that worked (last_good) and the server is no longer asleep; a failed
  // connect the user started (byUser) leaves it not asleep either.
  //
  // A Disconnect cancels the connects running or queued (cancelPending): one
  // still to start never starts; one finishing tears its session down instead
  // of installing it, and leaves user_disconnected, last_good and asleep alone.
  const handshake = connectOnce || connectPortalOnce;
  const pending = new Set();
  let connectQueue = Promise.resolve();
  const cancelledError = () => Object.assign(new Error('Disconnected while connecting.'), { cancelled: true });

  function connectPortal(body, { byUser = false } = {}) {
    const ticket = { cancelled: false };
    pending.add(ticket);
    const attempt = async () => {
      if (ticket.cancelled) throw cancelledError();
      const result = await handshake(body);
      if (ticket.cancelled) {
        dropSession(appState);
        throw cancelledError();
      }
      // Read after the cancel check, nothing awaited in between: a Disconnect can't land in the middle.
      const saved = cache.load() || {};
      delete saved.user_disconnected;
      cache.save({ ...saved, last_good: lastGoodFrom(body) });
      appState.asleep = false;
      appState.wakeError = null;
      appState.wakeRetryAt = 0;
      return result;
    };
    const run = connectQueue.then(attempt, attempt);
    connectQueue = run.catch(() => {});
    const tracked = run.catch((err) => {
      if (byUser && !err.cancelled) {
        appState.asleep = false;
        appState.wakeError = null;
      }
      throw err;
    });
    appState.connecting = tracked;
    tracked.catch(() => {}).then(() => {
      pending.delete(ticket);
      if (appState.connecting === tracked) appState.connecting = null;
    });
    return tracked;
  }

  function cancelPending() {
    for (const ticket of pending) ticket.cancelled = true;
  }

  // ── POST /api/auth/connect ─────────────────────────────────────────────────
  router.post('/connect', connectLimiter, connectRules, async (req, res) => {
    try {
      const result = await connectPortal(req.body, { byUser: true });
      appState.touchActivity?.();
      res.json({ success: true, ...result });
    } catch (err) {
      log.error(TAG, `connect failed: ${err.message}`);
      res.status(401).json({ error: err.message });
    }
  });

  // ── GET /api/auth/status ───────────────────────────────────────────────────
  // asleep: the idle timeout dropped the session — the next real use (a data
  // request through the session guard) reconnects to the last portal that
  // worked, shown as portal/mac. wakeError: why the last wake failed. A status
  // check never wakes it, or the apps' polling would keep the session up.
  router.get('/status', (req, res) => {
    const connected = !!(appState.sessionManager?.isAuthenticated());
    const saved = cache.load();
    const asleep = !connected && !!appState.asleep;
    const shown = asleep && saved?.last_good ? saved.last_good : saved;
    const watchdog = appState.sessionManager?._watchdog;
    res.json({
      connected,
      asleep,
      ...(asleep && appState.wakeError ? { wakeError: appState.wakeError } : {}),
      version: process.env.APP_VERSION || 'dev',
      portal: shown?.portal || null,
      mac: shown?.mac || null,
      profile: connected ? appState.sessionManager.getProfile() : null,
      token: connected ? appState.identity?.token : null,
      device: DEVICE_PROFILE,
      watchdog: watchdog ? { lastPingAt: watchdog.lastPingAt, pingCount: watchdog.pingCount } : null,
      lastActivityAt: appState.lastActivityAt || null,
      idleTimeoutMs: appState.idleTimeoutMs || null,
    });
  });

  // ── PUT /api/auth/config ───────────────────────────────────────────────────
  // Persist portal config fields WITHOUT initiating a connection.
  router.put('/config', (req, res) => {
    const existing = cache.load() || {};
    const before = { portal: existing.portal, mac: existing.mac };
    for (const key of CONNECTION_FIELDS) {
      if (req.body[key] !== undefined) {
        existing[key] = key === 'portal'
          ? normalizePortal(req.body[key])
          : req.body[key];
      }
    }
    // The connection that worked changed or went (deleted): nothing to wake to.
    // Any other one changing (a failed switch deleted) leaves it alone.
    const good = existing.last_good;
    if (isLastGood(before.portal, before.mac, good) && !isLastGood(existing.portal, existing.mac, good)) {
      delete existing.last_good;
      if (!appState.sessionManager) { appState.asleep = false; appState.wakeError = null; }
    }
    cache.save(existing);
    res.json({ success: true });
  });

  // ── GET /api/auth/config ───────────────────────────────────────────────────
  // Returns saved portal config so the WebUI can pre-fill the Setup form.
  router.get('/config', (req, res) => {
    const saved = cache.load();
    if (!saved) return res.json({});

    // Return only the flat setup fields; exclude internal stalker_* keys.
    const { portal, mac, timezone, lang, login, serial_number,
            device_id, device_id2, send_device_id, send_device_id2,
            signature, portal_signature,
            connection_timeout, token } = saved;

    // Collect all stalker_HASH token entries
    const tokens = {};
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('stalker_')) tokens[k] = v;
    }

    res.json({ portal, mac, timezone, lang, login, serial_number,
               device_id, device_id2, send_device_id, send_device_id2,
               signature, portal_signature,
               connection_timeout, token, tokens });
  });

  // ── DELETE /api/auth/disconnect ────────────────────────────────────────────
  router.delete('/disconnect', (req, res) => {
    if (appState.sessionManager) log.info(TAG, 'disconnecting session');
    // Turned off on purpose: a connect still running is cancelled, it is not
    // asleep (no request wakes it) — and saved, so a restart doesn't either.
    // The next successful connect clears it.
    cancelPending();
    dropSession(appState, { asleep: false });
    clearTimeout(appState._idleTimer);
    appState._idleTimer = null;
    appState.lastActivityAt = null;
    const saved = cache.load();
    if (saved) cache.save({ ...saved, user_disconnected: true });
    res.json({ success: true });
  });

  // ── POST /api/auth/reconnect ───────────────────────────────────────────────
  router.post('/reconnect', reconnectLimiter, async (req, res) => {
    const saved = cache.load();
    if (!saved?.portal || !saved?.mac) {
      return res.status(400).json({ error: 'No saved portal config found' });
    }
    // The saved connection is the one that worked: its password too (last_good).
    const body = isLastGood(saved.portal, saved.mac, saved.last_good) ? { ...saved, ...saved.last_good } : saved;
    try {
      const result = await connectPortal(body, { byUser: true });
      appState.touchActivity?.();
      res.json({ success: true, ...result });
    } catch (err) {
      log.error(TAG, `reconnect failed: ${err.message}`);
      res.status(401).json({ error: err.message });
    }
  });

  return { authRoutes: router, connectPortal };
};
