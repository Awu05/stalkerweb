'use strict';

// Optional access key (ACCESS_KEY). Unset, StalkerWeb is open as before — fine
// on a home network. Set, every request must prove it knows the key before it
// reaches the portal, the settings or a stream; needed once the server is
// reachable from the internet (a Cloudflare tunnel, a port forward).
//
// Two levels of access:
//   full   the key itself — the web UI (password login, then a cookie), the
//          Android app, anything else.
//   share  a token derived from the key — only what an IPTV player needs:
//          playlists, the guide, the Xtream API, the Stremio addon, streams and
//          images. Handing a playlist or addon link to someone (or to an app
//          that logs it) never gives away the settings or the portal account.
//
// Clients that can't send a header or a cookie (Stremio, VLC, Jellyfin, the
// Android app's player) carry the key or token in the path:
//   https://host/k/<token>/stremio/manifest.json
// The prefix is stripped before routing and kept in req.accessPrefix;
// baseUrl() adds it back to every link the server hands out, so the streams
// and images in a playlist work from where the playlist was fetched. Xtream
// players instead send the token as their password.
//
// Changing ACCESS_KEY revokes every cookie, link and token at once.

const crypto = require('crypto');
const log = require('../logger');
const TAG = 'access';

const COOKIE = 'sw_session';
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
const FAIL_LIMIT = 20;                  // wrong keys per address…
const FAIL_WINDOW_MS = 15 * 60 * 1000;  // …per 15 minutes before it is locked out
const MIN_KEY_LENGTH = 12;

const derive = (key, purpose) =>
  crypto.createHmac('sha256', key).update(`stalkerweb:${purpose}`).digest('base64url').slice(0, 32);

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// Which level a path needs: 'open', 'share' (anything a player uses) or 'full'.
// Xtream paths are 'xtream': share level, and the password may carry the token.
const XTREAM_QUERY = new Set(['/player_api.php', '/get.php', '/xmltv.php']);
const XTREAM_PATH = /^\/(?:live|movie|series)\/([^/]+)\/([^/]+)\/[^/]+$/;

function levelFor(req) {
  const p = req.path;
  if (p === '/api/health' || p.startsWith('/api/access/')) return 'open';
  if (p === '/api/logs' || p.startsWith('/api/logs/')) return 'open';   // has its own token (LOG_MONITOR_TOKEN)
  if (XTREAM_QUERY.has(p) || XTREAM_PATH.test(p)) return 'xtream';
  if (p.startsWith('/proxy/') || p.startsWith('/stremio/')) return 'share';
  if (/^\/api\/(?:m3u|xspf|xmltv)(?:\/|$)/.test(p)) return 'share';
  if (p.startsWith('/api/logos/') && (req.method === 'GET' || req.method === 'HEAD')) return 'share';
  if (p.startsWith('/api/') || p === '/api') return 'full';
  return 'open';   // the web app's own files and pages — it shows the login itself
}

function createAccess({ key = '', logger = log, now = Date.now } = {}) {
  const enabled = !!key;
  const shareToken = enabled ? derive(key, 'share') : null;
  const sessionToken = enabled ? derive(key, 'session') : null;
  const failures = new Map();   // address → { count, since }

  if (enabled && key.length < MIN_KEY_LENGTH) {
    logger.warn(TAG, `ACCESS_KEY is only ${key.length} characters — use at least ${MIN_KEY_LENGTH} (a passphrase or random string) if the server is reachable from the internet`);
  }

  // What a key or token grants: 'full', 'share' or null.
  function grantFor(secret) {
    if (!enabled || !secret) return null;
    if (sameSecret(secret, key)) return 'full';
    if (sameSecret(secret, shareToken)) return 'share';
    return null;
  }

  const lockedOut = (req) => {
    const f = failures.get(req.ip);
    if (!f) return false;
    if (now() - f.since > FAIL_WINDOW_MS) { failures.delete(req.ip); return false; }
    return f.count >= FAIL_LIMIT;
  };
  function recordFailure(req) {
    const f = failures.get(req.ip);
    if (!f || now() - f.since > FAIL_WINDOW_MS) failures.set(req.ip, { count: 1, since: now() });
    else if (++f.count === FAIL_LIMIT) logger.warn(TAG, `${req.ip}: ${FAIL_LIMIT} wrong access keys — locked out for 15 minutes`);
    if (failures.size > 10_000) failures.delete(failures.keys().next().value);
  }

  function deny(req, res, status, message) {
    if (req.path.startsWith('/api/') || req.path === '/player_api.php') {
      return res.status(status).json({ error: message, accessRequired: status === 401 });
    }
    return res.status(status).type('text/plain').send(message);
  }
  const tooMany = (req, res) => deny(req, res, 429, 'Too many wrong access keys — try again in 15 minutes.');

  // First middleware: takes /k/<token> off the path and remembers what it granted.
  function stripPrefix(req, res, next) {
    if (!enabled) return next();
    const m = /^\/k\/([^/?#]+)(.*)$/.exec(req.url);
    if (!m) return next();
    if (lockedOut(req)) return tooMany(req, res);
    let token;
    try { token = decodeURIComponent(m[1]); } catch { token = m[1]; }
    const grant = grantFor(token);
    if (!grant) {
      recordFailure(req);
      return res.status(401).type('text/plain').send('This link has the wrong access key. Copy a new one from StalkerWeb’s Profiles page.');
    }
    req.accessGrant = grant;
    req.accessPrefix = `/k/${encodeURIComponent(token)}`;
    req.url = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
    req.originalUrl = req.url;   // nothing downstream (logs, links) should see the key
    next();
  }

  // The grant a request carries without a /k/ prefix.
  function grantOf(req) {
    if (req.accessGrant) return req.accessGrant;
    if (sameSecret(readCookie(req, COOKIE), sessionToken)) return 'full';
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (bearer) return grantFor(bearer[1].trim());
    return null;
  }

  // Second middleware: lets a request through only with the access its path needs.
  function gate(req, res, next) {
    if (!enabled) return next();
    const level = levelFor(req);
    if (level === 'open') return next();
    let grant = grantOf(req);
    if (!grant && level === 'xtream') {
      // Xtream players send the token as the password, on every request.
      const password = XTREAM_PATH.exec(req.path)?.[2] ?? req.query.password;
      if (password !== undefined) {
        if (lockedOut(req)) return tooMany(req, res);
        let secret;
        try { secret = decodeURIComponent(String(password)); } catch { secret = String(password); }
        grant = grantFor(secret);
        if (grant) req.accessPrefix = `/k/${encodeURIComponent(secret)}`;   // so stream links it hands out carry it
        else recordFailure(req);
      }
    }
    if (!grant) return deny(req, res, 401, 'Access key required.');
    if (level === 'full' && grant !== 'full') return deny(req, res, 403, 'This link only allows playback, not the StalkerWeb settings.');
    req.accessGrant = grant;
    next();
  }

  // ── /api/access ─────────────────────────────────────────────────────────────

  function setCookie(req, res, value, maxAge) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function routes() {
    const router = require('express').Router();

    router.get('/status', (req, res) => {
      const grant = enabled ? grantOf(req) : 'full';
      res.json({ enabled, authenticated: grant === 'full' });
    });

    router.post('/login', (req, res) => {
      if (!enabled) return res.json({ success: true });
      if (lockedOut(req)) return tooMany(req, res);
      if (grantFor(String(req.body?.key ?? '')) !== 'full') {
        recordFailure(req);
        logger.warn(TAG, `${req.ip}: web login with a wrong access key`);
        return res.status(401).json({ error: 'Wrong access key.' });
      }
      setCookie(req, res, sessionToken, COOKIE_MAX_AGE_S);
      logger.info(TAG, `${req.ip}: signed in to the web UI`);
      res.json({ success: true });
    });

    router.post('/logout', (req, res) => {
      setCookie(req, res, '', 0);
      res.json({ success: true });
    });

    return router;
  }

  return { enabled, shareToken, grantFor, stripPrefix, gate, routes };
}

module.exports = { createAccess, levelFor };
