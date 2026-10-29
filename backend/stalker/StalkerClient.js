// StalkerClient.js
// Mirrors: SAPI.cpp + libstalkerclient (request.c, stb.c, itv.c, watchdog.c)
//
// This is the core HTTP client that communicates with a Stalker Middleware portal.
// All protocol details are ported 1:1 from the C++ pvr.stalker addon.

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { CookieJar, Cookie } = require('tough-cookie');
const { withCookieJar } = require('../lib/cookieJarAxios');
const { STB_VERSION_STRING } = require('./identity');
const log = require('../logger');
const TAG = 'StalkerClient';

// The STB user-agent is critical — portals detect it to decide whether
// to return their browser HTML UI or the JSON API responses.
// This exact string is what STBemu's MAG250 profile sends (captured from a
// live STBemu session against a Stalker portal).
const STB_USER_AGENT =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) ' +
  'MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

// Stable hex digest derived from device identity — used to fill the STBemu
// fingerprint fields (adid/prehash/hw_version_2/metrics random) when the user
// hasn't supplied the real values. Deterministic so the same device always
// presents the same fingerprint across sessions.
function deriveHex(algo, ...parts) {
  return crypto.createHash(algo).update(parts.join('|')).digest('hex');
}

class StalkerClient {
  constructor() {
    this.identity = null;   // sc_identity_t
    this.endpoint = '';     // m_endpoint  → e.g. http://host/stalker_portal/server/load.php
    this.basePath = '';     // m_basePath  → e.g. http://host/stalker_portal/
    this.referer  = '';     // m_referer   → e.g. http://host/stalker_portal/c/
    this.timeout  = 10000; // ms
    this._tokenChangedCb = null; // (newToken, prevToken) => void — fired on any rotation
    this.jar = new CookieJar();
    this.http = withCookieJar(axios.create({
      withCredentials: true,
      maxRedirects: 10
    }), this.jar);
  }

  setIdentity(identity) {
    this.identity = identity;
  }

  setTimeout(seconds) {
    this.timeout = seconds * 1000;
  }

  // No-op: STBemu never puts the token in a cookie — it sends it only as
  // `Authorization: Bearer <token>` (built in _buildHeaders from identity.token).
  // Kept for call-site compatibility with SessionManager.
  updateTokenCookie(_token) { /* token rides in the Authorization header */ }

  // Register a callback fired whenever ANY portal response rotates the token.
  setTokenChangedCallback(cb) { this._tokenChangedCb = cb; }

  // Centralized token capture. A real STB always honors the freshest token the
  // portal hands back — on handshake, get_profile, do_auth, AND on watchdog /
  // itv calls. We previously only captured it during the auth sequence, so a
  // mid-session rotation (returned in any js.token) was ignored until the
  // watchdog tripped a full re-auth — and channels zapped in that window failed
  // with "Authorization failed". Inspect every response's js.token here instead.
  _maybeUpdateToken(js) {
    if (!js || typeof js !== 'object' || Array.isArray(js)) return;
    const tok = js.token;
    if (typeof tok !== 'string' || !tok) return;
    if (!this.identity || tok === this.identity.token) return;
    const prev = this.identity.token;
    this.identity.token = tok;
    if (this._tokenChangedCb) {
      try { this._tokenChangedCb(tok, prev); } catch (e) { log.warn(TAG, `token-changed callback threw: ${e.message}`); }
    }
  }

  async initialize(url) {
    let server = url.trim();
    if (!server.includes('://')) server = 'http://' + server;

    log.info(TAG, `Discovering portal redirects for: ${server}`);

    // Fresh jar + client for each auth attempt (mirrors C# creating a new HttpClient)
    this.jar = new CookieJar();
    this.http = withCookieJar(axios.create({ withCredentials: true, maxRedirects: 10 }), this.jar);

    // Seed the identity cookies into the jar. STBemu sends ONLY these four on
    // every portal call — mac, stb_lang, timezone, adid — with mac and timezone
    // URL-encoded (e.g. mac=00%3A1A%3A79...). It does NOT cookie sn/device_id/
    // signature (those ride in the get_profile query) and does NOT cookie the
    // token (that rides in the Authorization header). The captured portal sets
    // no PHPSESSID at all — auth is purely mac-cookie + Bearer token.
    const id = this.identity;
    const uri = new URL(server);
    const domainUrl = `${uri.protocol}//${uri.host}`;

    const setCookie = (key, value, targetDomain = domainUrl) => {
      if (value !== undefined && value !== null && value !== '') {
        const cookie = new Cookie({ key, value: String(value) });
        this.jar.setCookieSync(cookie, targetDomain, { ignoreError: true });
      }
    };
    const seedIdentityCookies = (targetDomain) => {
      setCookie('mac', encodeURIComponent(id.mac), targetDomain);
      setCookie('stb_lang', id.lang || 'en', targetDomain);
      setCookie('timezone', encodeURIComponent(id.time_zone || 'America/New_York'), targetDomain);
      setCookie('adid', this.getAdid(), targetDomain);
    };

    seedIdentityCookies();

    try {
      const resp = await this.http.get(server, { 
        headers: { 'User-Agent': STB_USER_AGENT, 'X-User-Agent': 'Model: MAG250; Link: WiFi' },
        timeout: this.timeout,
        validateStatus: () => true 
      });
      // Get the effective URL after any redirects
      const effectiveUrl = resp.request && resp.request.res ? resp.request.res.responseUrl : server;
      if (effectiveUrl && effectiveUrl !== server) {
        log.info(TAG, `Redirect discovered. Effective URL: ${effectiveUrl}`);
        server = effectiveUrl;
        
        // Copy identity cookies to the new domain
        const newUri = new URL(server);
        const newDomainUrl = `${newUri.protocol}//${newUri.host}`;
        seedIdentityCookies(newDomainUrl);
      }
    } catch (e) {
      log.warn(TAG, `Could not discover redirects (non-fatal): ${e.message}`);
    }

    // Set endpoints based on effective server URL
    this.setEndpoint(server);

    // Load portal page to establish PHPSESSID
    const portalPageUrl = `${this.basePath}c/`;
    log.info(TAG, `Loading portal page to establish session: ${portalPageUrl}`);
    try {
      await this.http.get(portalPageUrl, {
        headers: { 'User-Agent': STB_USER_AGENT, 'X-User-Agent': 'Model: MAG250; Link: WiFi' },
        timeout: this.timeout,
        validateStatus: () => true
      });
    } catch (e) {
      log.warn(TAG, `Could not load portal page (non-fatal): ${e.message}`);
    }
  }

  // ── Endpoint normalisation ─────────────────────────────────────────────────
  // Direct port of SAPI::SetEndpoint() including the xpcom.common.js logic.
  //
  // Given:  http://host/stalker_portal/c/
  // Result: basePath = http://host/stalker_portal/
  //         endpoint = http://host/stalker_portal/server/load.php
  //         referer  = http://host/stalker_portal/c/
  //
  // Given:  http://host/stalker_portal/server/load.php
  // Result: basePath = http://host/stalker_portal/server/
  //         endpoint = http://host/stalker_portal/server/load.php
  //         referer  = http://host/stalker_portal/server/
  setEndpoint(url) {
    let server = url.trim();

    // Strip query string and fragment if any
    const qMark = server.indexOf('?');
    if (qMark !== -1) {
      server = server.slice(0, qMark);
    }
    const hashMark = server.indexOf('#');
    if (hashMark !== -1) {
      server = server.slice(0, hashMark);
    }

    // Ensure scheme
    if (!server.includes('://')) {
      server = 'http://' + server;
    }

    const schemeEnd = server.indexOf('://') + 3; // index of first char after "://"
    const afterScheme = server.slice(schemeEnd);

    // Find last '/' in the path portion
    let lastSlash = afterScheme.lastIndexOf('/');

    if (lastSlash === -1) {
      // No slash at all after scheme — append one
      server += '/';
      lastSlash = server.length - schemeEnd - 1;
    }

    // Absolute index of the last slash in `server`
    const pos = schemeEnd + lastSlash; // mirrors: pos += startPos in SAPI.cpp

    // Check for /c/ pattern — server.substr(pos - 2, 3) == "/c/"
    const threeChars = server.slice(pos - 2, pos + 1);
    const afterLastSlash = server.slice(pos + 1);

    if (threeChars === '/c/' && !afterLastSlash.includes('.php')) {
      // Strip the /c segment:
      //   m_basePath = server.substr(0, pos - 1)   (cuts off "c/")
      //   m_endpoint = m_basePath + "server/load.php"
      //   m_referer  = server.substr(0, pos + 1)   (keeps "c/")
      this.basePath = server.slice(0, pos - 2) + '/'; // up to and including slash before "c"
      this.endpoint = this.basePath + 'server/load.php';
      this.referer  = server.slice(0, pos + 1); // includes trailing slash of /c/
    } else {
      // Non-/c/ URL — use as-is
      this.basePath = server.slice(0, pos + 1); // up to and including last slash
      this.endpoint = server;
      this.referer  = this.basePath;
    }

    log.info(TAG, `basePath=${this.basePath}  endpoint=${this.endpoint}  referer=${this.referer}`);
  }

  getBasePath() {
    return this.basePath;
  }

  // ── STBemu fingerprint helpers ─────────────────────────────────────────────
  // STBemu sends a handful of device-derived hashes (adid, prehash, hw_version_2,
  // metrics "random"). They're computed by the STB firmware from stable device
  // data, so we reproduce stable values from mac/serial when the user hasn't
  // supplied the real ones. Configure identity.{adid,prehash,hw_version_2,
  // metrics_random} for byte-exact mimicry of a specific box.
  getAdid() {
    const id = this.identity;
    return id.adid || deriveHex('md5', id.mac, id.serial_number);          // 32 hex
  }
  getPrehash() {
    const id = this.identity;
    return id.prehash || deriveHex('sha1', id.mac, id.serial_number);      // 40 hex
  }
  getHwVersion2() {
    const id = this.identity;
    return id.hw_version_2 || deriveHex('sha1', id.serial_number, id.mac); // 40 hex
  }
  getMetricsRandom() {
    const id = this.identity;
    return id.metrics_random || deriveHex('sha1', id.mac, 'metrics');      // 40 hex
  }

  // Returns the authenticated axios instance for use by the HLS proxy.
  // The cookie jar (mac, stb_lang, timezone, adid + any portal-set cookies) is
  // already attached. The token is NOT a cookie — it rides in Authorization.
  getHttpClient() {
    return this.http;
  }

  // Minimal headers for direct stream/segment requests (not Stalker API calls).
  // Stream CDNs expect the player's libavformat fingerprint, exactly as STBemu
  // sends it (captured: `User-Agent: Lavf53.32.100`, `Connection: Keep-Alive`,
  // no Referer/X-User-Agent). STBemu serves a whole movie over ONE persistent
  // connection; the proxy's stream client (keepAlive, maxSockets:1) reuses one
  // socket the same way, which these CDNs require. Portal API calls use
  // _buildHeaders() — unaffected.
  getStreamHeaders() {
    return {
      'User-Agent':      'Lavf53.32.100',
      'Accept-Encoding': 'gzip',
      'Connection':      'keep-alive',
    };
  }

  // Pick the right headers for fetching/probing a resolved stream URL.
  // Portal-internal URLs (same host/subdomain as the portal) need the full STB
  // header set incl. Authorization: Bearer; external CDN hosts get the minimal
  // libavformat fingerprint STBemu uses (no Bearer, no Referer). Shared by the
  // HLS proxy and the codec/type probe so both authenticate identically.
  streamHeadersFor(url) {
    const basePath = this.getBasePath();
    let internal = false;
    if (basePath) {
      try {
        const u = new URL(url);
        const b = new URL(basePath);
        internal = u.hostname === b.hostname || u.hostname.endsWith('.' + b.hostname);
      } catch { internal = false; }
    }
    if (internal) {
      const headers = { ...this._buildHeaders() };
      delete headers['X-Requested-With'];
      delete headers['Accept'];
      return headers;
    }
    return { ...this.getStreamHeaders() };
  }

  // ── Header building ────────────────────────────────────────────────────────
  // Reproduces the exact header set STBemu sends on every load.php call
  // (captured from a live session). Cookies are NOT set here — they live in the
  // cookie jar (seeded in initialize() with mac/stb_lang/timezone/adid, the only
  // cookies STBemu sends) and are injected by lib/cookieJarAxios. The token
  // rides solely in the Authorization header, never in a cookie.
  //
  // Notable STBemu quirks reproduced: a misspelled `Referrer` header sent IN
  // ADDITION to `Referer`, `Accept: */*` (not application/json), an explicit
  // `Cache-Control: no-cache`, and NO `X-Requested-With`.
  _buildHeaders(isHandshake = false) {
    const id = this.identity;

    const headers = {
      'User-Agent':      STB_USER_AGENT,
      'Referrer':        this.referer,            // STBemu sends both spellings
      'X-User-Agent':    'Model: MAG250; Link: WiFi',
      'Referer':         this.referer,
      'Accept':          '*/*',
      'Cache-Control':   'no-cache',
      'Accept-Encoding': 'gzip',
    };

    if (!isHandshake && id.token) {
      headers['Authorization'] = `Bearer ${id.token}`;
    }

    return headers;
  }

  // ── Core HTTP call ─────────────────────────────────────────────────────────
  // Mirrors SAPI::StalkerCall()
  async _stalkerCall(queryParams, isHandshake = false) {
    const headers = this._buildHeaders(isHandshake);

    // JsHttpRequest=1-xml is required on all calls so the portal returns JSON
    // instead of the browser HTML UI. The C# reference appends it to every URL.
    const params = new URLSearchParams({ ...queryParams, JsHttpRequest: '1-xml' });
    let url = `${this.endpoint}?${params.toString()}`;

    // 404 Fallback logic for handshake
    if (isHandshake) {
      const urlsToTry = [
        url,
        `${this.basePath}stalker_portal/server/load.php?${params.toString()}`,
        `${this.basePath}portal/server/load.php?${params.toString()}`
      ];

      let lastError = null;
      for (const tryUrl of urlsToTry) {
        log.info(TAG, `GET ${tryUrl}`);
        try {
          const response = await this.http.get(tryUrl, {
            headers,
            timeout: this.timeout,
            validateStatus: (status) => status < 500 // Accept 404 so we can inspect it
          });

          if (response.status === 429) {
            throw new StalkerError('RATE_LIMITED', 'Portal rate-limited handshake (HTTP 429).');
          }
          if (response.status === 404) {
            log.warn(TAG, `404 Not Found at ${tryUrl}, trying fallback...`);
            continue; // try next
          }
          if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}`);
          }

          // Use the final URL after any redirect, fall back to the URL we tried
          const landedUrl = (response.request?.res?.responseUrl) || tryUrl;

          // Always update endpoints from wherever the handshake actually landed.
          // Mirrors C# which re-derives _effectiveBaseUrl from the final request URI.
          // Strip query string then extract basePath from the /server/load.php position.
          const landedPath = landedUrl.split('?')[0];
          const serverIdx  = landedPath.indexOf('/server/load.php');
          if (serverIdx !== -1) {
            this.basePath = landedPath.substring(0, serverIdx) + '/';
            this.endpoint = landedPath;
            this.referer  = landedPath.substring(0, serverIdx) + '/c/';
          } else {
            this.setEndpoint(landedPath);
          }
          log.info(TAG, `Handshake landed at ${landedPath} → basePath=${this.basePath}`);

          const parsed = this._parseResponse(response.data);
          this._maybeUpdateToken(parsed?.js);
          return parsed;
        } catch (e) {
          lastError = e;
        }
      }
      throw new StalkerError('API', `Handshake failed on all paths. Last error: ${lastError ? lastError.message : '404 Not Found'}`);
    } else {
      const bulkAction = queryParams.action === 'get_ordered_list' || queryParams.action === 'get_epg_info';
      if (!bulkAction) log.info(TAG, `GET ${url}`);
      let response;
      try {
        response = await this.http.get(url, {
          headers,
          timeout: this.timeout,
          validateStatus: (s) => s < 500,
        });
      } catch (err) {
        if (err.response?.status === 429) {
          throw new StalkerError('RATE_LIMITED', 'Portal rate-limited this request (HTTP 429).');
        }
        throw err;
      }
      if (response.status === 429) {
        throw new StalkerError('RATE_LIMITED', 'Portal rate-limited this request (HTTP 429).');
      }
      if (response.status >= 400) {
        throw new StalkerError('API', `HTTP ${response.status}`);
      }
      const parsed = this._parseResponse(response.data);
      this._maybeUpdateToken(parsed?.js);
      return parsed;
    }
  }

  _parseResponse(body) {
    if (typeof body === 'string') {
      if (body.includes('Authorization failed')) {
        throw new StalkerError('AUTHORIZATION', 'Portal returned: Authorization failed.');
      }
      if (body.trimStart().startsWith('<!') || body.trimStart().startsWith('<html')) {
        throw new StalkerError(
          'API',
          `Portal returned HTML instead of JSON. Check your portal URL — it should ` +
          `end in /c/ (e.g. http://host/stalker_portal/c/). ` +
          `Received: ${body.slice(0, 120)}...`
        );
      }
      throw new StalkerError('API', `Unexpected string response: ${body.slice(0, 300)}`);
    }

    return body; // parsed JSON object
  }

  // ── STB: handshake ─────────────────────────────────────────────────────────
  // Mirrors SAPI::STBHandshake() + stb.c sc_stb_handshake_defaults()
  async stbHandshake() {
    const params = {
      type:    'stb',
      action:  'handshake',
      token:   this.identity.token || '',
      prehash: this.getPrehash(),   // STBemu sends prehash on handshake too
    };
    return this._stalkerCall(params, /* isHandshake= */ true);
  }

  // ── STB: get_profile ───────────────────────────────────────────────────────
  // Mirrors SAPI::STBGetProfile() + stb.c sc_stb_get_profile_defaults()
  async stbGetProfile(authSecondStep = false) {
    const id = this.identity;
    const sn  = id.serial_number || '0000000000000';
    // uid mirrors whichever device_id STBemu would actually transmit — same
    // send_device_id/send_device_id2 gating as the request params below, so
    // an ID the portal never associated with this account doesn't leak in here.
    const uid = (id.send_device_id  !== false && id.device_id)  ||
                (id.send_device_id2 !== false && id.device_id2) || '';

    // metrics JSON — STBemu sends mac with RAW colons inside this blob (unlike
    // the URL-encoded mac cookie). uid mirrors device_id; random is a stable hash.
    const metrics = JSON.stringify({
      mac:    id.mac,
      sn,
      model:  'MAG250',
      type:   'STB',
      uid,
      random: this.getMetricsRandom(),
    });

    const params = {
      type:             'stb',
      action:           'get_profile',
      hd:               '1',
      ver:              STB_VERSION_STRING,
      num_banks:        '2',          // STBemu sends 2
      sn,
      stb_type:         'MAG250',
      client_type:      'STB',
      image_version:    '216',
      video_out:        'hdmi',
      hw_version:       '1.7-BD-00',
      not_valid_token:  id.valid_token ? '0' : '1',
      auth_second_step: authSecondStep ? '1' : '0',
      metrics,
      hw_version_2:     this.getHwVersion2(),
      timestamp:        String(Math.floor(Date.now() / 1000)),
      api_signature:    '262',
      prehash:          this.getPrehash(),
    };

    if (id.device_id  && id.send_device_id  !== false) params.device_id  = id.device_id;
    if (id.device_id2 && id.send_device_id2 !== false) params.device_id2 = id.device_id2;
    if (id.signature)  params.signature  = id.signature;

    return this._stalkerCall(params);
  }

  // ── STB: do_auth ──────────────────────────────────────────────────────────
  // Mirrors SAPI::STBDoAuth() + stb.c sc_stb_do_auth_defaults()
  async stbDoAuth() {
    const id = this.identity;
    const params = {
      type:     'stb',
      action:   'do_auth',
      login:    id.login || id.mac, // fallback: use MAC as login (common pattern)
      password: id.password || '',
    };
    if (id.device_id  && id.send_device_id  !== false) params.device_id  = id.device_id;
    if (id.device_id2 && id.send_device_id2 !== false) params.device_id2 = id.device_id2;

    return this._stalkerCall(params);
  }

  // ── ITV: get_all_channels ─────────────────────────────────────────────────
  async itvGetAllChannels() {
    return this._stalkerCall({ type: 'itv', action: 'get_all_channels' });
  }

  // ── ITV: get_ordered_list ─────────────────────────────────────────────────
  async itvGetOrderedList(genre = '*', page = 1) {
    return this._stalkerCall({
      type:   'itv',
      action: 'get_ordered_list',
      genre:  String(genre),
      fav:    '0',
      sortby: 'number',
      p:      String(page),
    });
  }

  // ── ITV: create_link ──────────────────────────────────────────────────────
  async itvCreateLink(cmd) {
    return this._stalkerCall({
      type:                'itv',
      action:              'create_link',
      cmd,
      series:              '',
      forced_storage:      '0',
      disable_ad:          '0',
      download:            '0',
      force_ch_link_check: '0',
    });
  }

  // ── ITV: get_genres ───────────────────────────────────────────────────────
  async itvGetGenres() {
    return this._stalkerCall({ type: 'itv', action: 'get_genres' });
  }

  // ── ITV: get_epg_info ─────────────────────────────────────────────────────
  async itvGetEPGInfo(period = 24) {
    return this._stalkerCall({ type: 'itv', action: 'get_epg_info', period: String(period) });
  }

  // ── Watchdog: get_events ──────────────────────────────────────────────────
  async watchdogGetEvents(curPlayType = 1, eventActiveId = 0) {
    return this._stalkerCall({
      type:            'watchdog',
      action:          'get_events',
      init:            '0',
      cur_play_type:   String(curPlayType),
      event_active_id: String(eventActiveId),
    });
  }

  // ── Matrix channel URL resolution ─────────────────────────────────────────
  // Mirrors the matrix block in StalkerInstance::GetChannelStreamURL()
  async resolveMatrixUrl(cmd) {
    // Use filter(Boolean) to discard empty segments from trailing slashes,
    // then take the last path segment as the channel identifier.
    // Strip any query string from the segment so ?token=abc doesn't corrupt the matrix API call.
    const parts = cmd.split('/').filter(Boolean);
    const channel = (parts[parts.length - 1] || '').split('?')[0];
    if (!channel) {
      log.warn(TAG, `resolveMatrixUrl: could not extract channel segment from cmd="${cmd}"`);
    }

    const matrixUrl =
      `${this.basePath}server/api/matrix.php` +
      `?channel=${encodeURIComponent(channel)}` +
      `&mac=${encodeURIComponent(this.identity.mac)}`;

    log.info(TAG, `resolveMatrixUrl: GET ${matrixUrl}`);

    const response = await this.http.get(matrixUrl, {
      headers: this._buildHeaders(),
      timeout: this.timeout,
    });

    const body = response.data;
    log.debug(TAG, `resolveMatrixUrl: raw response type=${typeof body} body=${JSON.stringify(body)?.slice(0, 200)}`);

    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (!trimmed) {
        log.warn(TAG, `resolveMatrixUrl: empty string response`);
        return null;
      }
      const p = trimmed.split(' ');
      const resolved = p[p.length - 1];
      log.info(TAG, `resolveMatrixUrl: resolved="${resolved}"`);
      return resolved;
    }

    log.warn(TAG, `resolveMatrixUrl: unexpected non-string response (type=${typeof body})`);
    return null;
  }
}

// Custom error class for Stalker protocol errors
class StalkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StalkerError';
    this.code = code; // 'AUTHORIZATION' | 'API' | 'AUTHENTICATION' | 'UNKNOWN'
  }
}

module.exports = { StalkerClient, StalkerError };
