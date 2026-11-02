// SessionManager.js
// Mirrors: SessionManager.cpp + DoHandshake/DoAuth/GetProfile/Authenticate logic
//
// Manages the full Stalker authentication lifecycle:
//   1. Handshake  → get token
//   2. GetProfile → check status (0=ok, 2=need credentials, 1=error)
//   3. DoAuth     → send login/password (only if status=2)
//   4. GetProfile(authSecondStep=true)
//
// After authentication, starts the WatchdogService to keep the session alive.

'use strict';

const WatchdogService = require('./WatchdogService');
const log = require('../logger');
const TAG = 'SessionManager';

const AUTH_CHECK_INTERVAL_MS = 30000;

class SessionManager {
  constructor(client) {
    this.client = client;           // StalkerClient instance
    this.identity = null;           // reference to shared identity object
    this.profile = null;            // STB profile from get_profile response
    this.authenticated = false;
    this.isAuthenticating = false;
    this.hasManualToken = false;
    this.lastError = null;
    this._watchdog = null;
    this._authTimer = null;
    this._statusCallback = null;    // (status: 'ok'|'lost'|'error') => void
    this._tokenPersistCb = null;    // (newToken) => void — persist a rotated token
    this._destroyed = false;        // destroy() is final: an authenticate still running starts no timers

    // Token rotation is captured centrally in StalkerClient (any response with a
    // js.token). React to it here: keep the cookie/state in sync and persist the
    // new token to disk so a mid-session rotation survives a restart (otherwise
    // the next boot reconnects with a stale token the portal may have retired).
    client.setTokenChangedCallback?.((newToken, prevToken) => {
      log.info(TAG, `token rotated: ${prevToken || '(none)'} → ${newToken}`);
      this.client.updateTokenCookie(newToken);
      if (this._tokenPersistCb) {
        try { this._tokenPersistCb(newToken); } catch (e) { log.warn(TAG, `token persist failed: ${e.message}`); }
      }
    });
  }

  setIdentity(identity, hasManualToken = false) {
    this.identity = identity;
    this.hasManualToken = hasManualToken;
  }

  setStatusCallback(cb) {
    this._statusCallback = cb;
  }

  // Register a callback invoked whenever the token rotates, so the caller can
  // persist it (e.g. CacheManager.saveToken).
  setTokenPersistCallback(cb) {
    this._tokenPersistCb = cb;
  }

  // Capture portal_signature from any API response JS object.
  // The portal may return a `signature` field in handshake, do_auth, or
  // get_profile. Once captured it replaces the device signature in all
  // subsequent Cookie headers (sig=...).
  _applyPortalSignature(js) {
    if (!js || typeof js !== 'object') return;
    const sig = js.signature || js.portal_signature;
    if (sig && typeof sig === 'string' && sig.trim()) {
      const clean = sig.trim();
      if (clean !== this.identity.portal_signature) {
        log.info(TAG, `portal_signature received: ${clean}`);
        this.identity.portal_signature = clean;
        this.client.setIdentity(this.identity);
      }
    }
  }

  isAuthenticated() {
    return this.authenticated;
  }

  getProfile() {
    return this.profile;
  }

  // ── Handshake ──────────────────────────────────────────────────────────────
  // Mirrors SessionManager::DoHandshake()
  async _doHandshake() {
    log.info(TAG, 'starting handshake…');
    const data = await this.client.stbHandshake();

    if (!data || !data.js) throw new Error('Handshake: empty response');

    // Token capture is centralized in StalkerClient._maybeUpdateToken (which
    // fires the token-changed callback for logging + persistence). Here we only
    // record the not_valid flag and any portal signature.
    if (data.js.not_valid !== undefined) {
      this.identity.valid_token = !Number(data.js.not_valid);
    }

    this._applyPortalSignature(data.js);
    log.info(TAG, 'handshake ok');
  }

  // ── DoAuth ─────────────────────────────────────────────────────────────────
  // Mirrors SessionManager::DoAuth()
  async _doAuth() {
    log.info(TAG, 'sending credentials…');
    const data = await this.client.stbDoAuth();

    if (data && data.js === false) {
      throw new Error('do_auth: authentication rejected by portal');
    }

    // Token rotation handled centrally in StalkerClient; just capture signature.
    if (data && data.js && typeof data.js === 'object') {
      this._applyPortalSignature(data.js);
    }
  }

  // ── GetProfile ─────────────────────────────────────────────────────────────
  // Mirrors SessionManager::GetProfile() — recursive on status=2
  async _getProfile(authSecondStep = false) {
    log.info(TAG, authSecondStep ? 'verifying credentials…' : 'fetching profile…');
    const data = await this.client.stbGetProfile(authSecondStep);

    if (!data || !data.js) throw new Error('get_profile: empty response');

    // Token rotation handled centrally in StalkerClient; just capture signature.
    if (data && data.js && typeof data.js === 'object') {
      this._applyPortalSignature(data.js);
    }

    const js = data.js;
    this.profile = {
      store_auth_data_on_stb: !!js.store_auth_data_on_stb,
      status: js.status !== undefined ? Number(js.status) : -1,
      msg: js.msg || '',
      block_msg: js.block_msg || '',
      watchdog_timeout: js.watchdog_timeout !== undefined ? Number(js.watchdog_timeout) : 120,
      timeslot: js.timeslot !== undefined ? Number(js.timeslot) : 90,
    };

    log.debug(TAG, `profile: status=${this.profile.status}, timeslot=${this.profile.timeslot}s`);

    switch (this.profile.status) {
      case 0:
        return; // authenticated!

      case 2:
        // Need credentials
        await this._doAuth();
        await this._getProfile(true); // recursive second step
        return;

      case 1:
      default:
        throw new Error(`Portal blocked: ${this.profile.msg || this.profile.block_msg || 'unknown'}`);
    }
  }

  // ── Full authenticate sequence ─────────────────────────────────────────────
  // Mirrors SessionManager::Authenticate() — no retry loop (C# reference has none).
  // Throws on failure so the caller (auth route) can surface the error to the user.
  async authenticate() {
    if (this.isAuthenticating) return;

    this.isAuthenticating = true;
    this.authenticated = false;
    this.lastError = null;
    this._stopWatchdog();

    try {
      // Always run the handshake — it's the only step that probes the endpoint
      // fallback paths (/server/load.php, /stalker_portal/server/load.php, etc.)
      // and updates basePath/endpoint/referer to wherever the portal actually lives.
      // Skipping it when hasManualToken=true caused 404s when the /c/ redirect
      // lands on a different domain than the real API.
      await this._doHandshake();
      await this._getProfile();
      this.authenticated = true;
      log.info(TAG, 'authenticated ✓');
    } catch (err) {
      this.lastError = err.message;
      this.isAuthenticating = false;
      if (this._statusCallback) this._statusCallback('error');
      throw err;
    }

    this.isAuthenticating = false;
    // Destroyed while authenticating (replaced, disconnected): leave it dead —
    // timers started now would ping the portal forever.
    if (this._destroyed) {
      this.authenticated = false;
      return;
    }
    if (this._statusCallback) this._statusCallback('ok');
    this._startWatchdog();
    this._startAuthChecker();
  }

  // ── Watchdog ───────────────────────────────────────────────────────────────
  _startWatchdog() {
    if (this._watchdog) return;
    const timeslot = this.profile?.timeslot || 90;
    this._watchdog = new WatchdogService(timeslot, this.client, (err) => {
      if (err === 'AUTHORIZATION') {
        log.warn(TAG, 'session expired — will re-authenticate');
        this.authenticated = false;
      }
    });
    this._watchdog.start();
  }

  _stopWatchdog() {
    if (this._watchdog) {
      this._watchdog.stop();
      this._watchdog = null;
    }
  }

  // ── Auth checker (re-auth loop) ────────────────────────────────────────────
  // Mirrors SessionManager::StartAuthInvoker()
  _startAuthChecker() {
    if (this._authTimer) return;
    this._authTimer = setInterval(async () => {
      if (!this.authenticated && !this.isAuthenticating) {
        log.info(TAG, 're-authenticating with portal…');
        try {
          await this.authenticate();
        } catch (e) {
          log.error(TAG, `re-auth failed: ${e.message}`);
        }
      }
    }, AUTH_CHECK_INTERVAL_MS);
  }

  destroy() {
    this._destroyed = true;
    if (this._authTimer) {
      clearInterval(this._authTimer);
      this._authTimer = null;
    }
    this._stopWatchdog();
    this.authenticated = false;
  }
}

module.exports = SessionManager;
