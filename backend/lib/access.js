'use strict';

// Optional access key (ACCESS_KEY). Unset, StalkerWeb is open as before — fine
// on a home network. Set, every request must prove it knows the key before it
// reaches the portal, the settings or a stream; needed once the server is
// reachable from the internet (a Cloudflare tunnel, a port forward).
//
// Two levels of access:
//   full   the key itself — the web UI (password sign-in, then a cookie), the
//          Android app (an Authorization header), anything else.
//   share  a token derived from the key — only what an IPTV player needs:
//          playlists, the guide, the Xtream API, the Stremio addon, streams and
//          images. Handing a playlist or addon link to someone (or to an app
//          that logs it) never gives away the settings or the portal account.
//
// Clients that can't send a header or a cookie (Stremio, VLC, Jellyfin, a
// cast device) carry the token in the path:
//   https://host/k/<token>/stremio/manifest.json
// The prefix is stripped before routing and req.accessPrefix is set; baseUrl()
// adds it to every link the server hands out, so the streams and images in a
// playlist work from where the playlist was fetched. Handed-out links always
// carry the share token, never the key. Xtream players instead send the token
// as their password.
//
// Changing ACCESS_KEY revokes every cookie, link and token at once.

const crypto = require('crypto');
const log = require('../logger');
const TAG = 'access';

const COOKIE = 'sw_session';
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
const FAIL_LIMIT = 20;                   // wrong keys from one address…
const GLOBAL_FAIL_LIMIT = 200;           // …or from everywhere together…
const FAIL_WINDOW_MS = 15 * 60 * 1000;   // …within 15 minutes lock out further tries…
const LOCKOUT_MS = 15 * 60 * 1000;       // …for 15 minutes
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

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// The path as routing could read it: decoded, lower case (Express matches
// routes case-insensitively), no repeated or trailing slashes (it ignores a
// trailing one). Judging the access a path needs on this form means no
// spelling of a route reaches it with less.
function normalPath(path) {
  const p = decode(path).toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return p || '/';
}

// What the web app itself needs before sign-in: its page and the files the
// build puts next to it.
const APP_FILES = new Set(['/', '/index.html', '/favicon.svg', '/manifest.json', '/sw.js']);
// Under these, every route needs a grant.
const PROTECTED_ROOTS = new Set(['api', 'proxy', 'stremio', 'live', 'movie', 'series', 'k']);
const XTREAM_FILES = new Set(['/player_api.php', '/get.php', '/xmltv.php', '/panel_api.php']);
const XTREAM_ROOTS = new Set(['live', 'movie', 'series']);

/**
 * The level a request needs: 'open', 'share' (anything a player uses), 'xtream'
 * (share, and the password may carry the token) or 'full'. Deny by default:
 * a path that isn't recognised needs full access.
 */
function levelFor(req, { logToken = false } = {}) {
  const p = normalPath(req.path);
  const read = req.method === 'GET' || req.method === 'HEAD';
  const root = p.split('/')[1];
  if (p === '/api/health' || p === '/api/access/status' || p === '/api/access/login' || p === '/api/access/logout') return 'open';
  // /api/logs checks LOG_MONITOR_TOKEN itself. Without one it only trusts
  // loopback, which a tunnel on the same host makes every visitor.
  if ((p === '/api/logs' || p.startsWith('/api/logs/')) && logToken) return 'open';
  if (XTREAM_FILES.has(p) || XTREAM_ROOTS.has(root)) return 'xtream';
  if (root === 'proxy' || root === 'stremio') return 'share';
  if (/^\/api\/(?:m3u|xspf|xmltv)(?:\/|$)/.test(p)) return 'share';
  if (p.startsWith('/api/logos/') && read) return 'share';
  if (PROTECTED_ROOTS.has(root)) return 'full';
  if (read && (APP_FILES.has(p) || p.startsWith('/assets/'))) return 'open';
  // A page of the web app (its routes have no file extension) — the server
  // answers those with index.html, which shows the sign-in.
  if (read && !/\.[^/]*$/.test(p)) return 'open';
  return 'full';
}

function createAccess({ key = '', logToken = false, logger = log, now = Date.now } = {}) {
  const enabled = !!key;
  const shareToken = enabled ? derive(key, 'share') : null;
  const sessionToken = enabled ? derive(key, 'session') : null;
  const sharePrefix = enabled ? `/k/${shareToken}` : '';
  const failures = new Map();   // address → { count, since, until }
  const everyone = { count: 0, since: 0, until: 0 };

  if (enabled && key.length < MIN_KEY_LENGTH) {
    logger.warn(TAG, `ACCESS_KEY is only ${key.length} characters — use at least ${MIN_KEY_LENGTH} (a passphrase or random string) if the server is reachable from the internet`);
  }

  // The lockout guards guesses at the key itself, the one secret a person
  // chooses. The share token and the session cookie are long random values —
  // nothing to guess — so they are always checked: while an address (or,
  // under a spread-out attack, everyone) is locked out, players with links and
  // signed-in browsers keep working; only sign-ins with the key wait.
  //
  // The address is req.ip: the client's address as the tunnel or reverse proxy
  // reports it ('trust proxy' in server.js). Without a proxy a client can write
  // that header itself and spread its tries over made-up addresses, which the
  // overall limit catches.
  const lockedOut = (req) => {
    const t = now();
    return (failures.get(req.ip)?.until ?? 0) > t || everyone.until > t;
  };
  function count(entry, limit, who) {
    const t = now();
    if (t - entry.since > FAIL_WINDOW_MS) { entry.count = 0; entry.since = t; }
    if (++entry.count >= limit) {
      entry.until = t + LOCKOUT_MS;
      entry.count = 0;
      logger.warn(TAG, `${who}: ${limit} wrong access keys in 15 minutes — sign-in with the key refused for 15 minutes`);
    }
  }
  function recordFailure(req) {
    let f = failures.get(req.ip);
    if (!f) {
      f = { count: 0, since: now(), until: 0 };
      failures.set(req.ip, f);
      if (failures.size > 10_000) failures.delete(failures.keys().next().value);
    }
    count(f, FAIL_LIMIT, req.ip);
    count(everyone, GLOBAL_FAIL_LIMIT, 'all addresses');
  }

  /**
   * What a presented key or token grants: 'full', 'share', null (wrong, and
   * counted) or 'locked' (the key may not be tried right now).
   */
  function check(req, secret) {
    if (!enabled || !secret) return null;
    if (sameSecret(secret, shareToken)) return 'share';
    if (lockedOut(req)) return 'locked';
    if (sameSecret(secret, key)) return 'full';
    recordFailure(req);
    return null;
  }

  function deny(req, res, status, message) {
    const p = normalPath(req.path);
    if (p.startsWith('/api/') || p === '/player_api.php') {
      return res.status(status).json({ error: message, accessRequired: status === 401 });
    }
    return res.status(status).type('text/plain').send(message);
  }
  const tooMany = (req, res) => deny(req, res, 429, 'Too many wrong access keys — try again in 15 minutes.');

  // Takes /k/<token> off the path and remembers what it granted. Runs before
  // routing; the request log runs before it and hides the token.
  function stripPrefix(req, res, next) {
    if (!enabled) return next();
    const m = /^\/k\/([^/?#]+)(.*)$/i.exec(req.url);
    if (!m) return next();
    const grant = check(req, decode(m[1]));
    if (grant === 'locked') return tooMany(req, res);
    if (!grant) return res.status(401).type('text/plain').send('This link has the wrong access key. Copy a new one from the StalkerWeb Profiles page.');
    req.accessGrant = grant;
    // Links handed out carry the share token, whatever was presented: a link
    // that leaks (a cast device, a proxy log) never carries the key itself.
    req.accessPrefix = sharePrefix;
    req.url = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
    req.originalUrl = req.url;
    next();
  }

  // The grant a request carries without a /k/ prefix (or 'locked').
  function grantOf(req) {
    if (req.accessGrant) return req.accessGrant;
    if (sameSecret(readCookie(req, COOKIE), sessionToken)) return 'full';
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (bearer) {
      const grant = check(req, bearer[1].trim());
      // Links in what it gets back work without the header (a player, a cast device).
      if (grant === 'full' || grant === 'share') req.accessPrefix = sharePrefix;
      return grant;
    }
    return null;
  }

  // Lets a request through only with the access its path needs.
  function gate(req, res, next) {
    if (!enabled) return next();
    const level = levelFor(req, { logToken });
    if (level === 'open') return next();
    let grant = grantOf(req);
    if (!grant && level === 'xtream') {
      // Xtream players send the token as the password on every request — in
      // the path (/live/<user>/<password>/<id>), the query, or a POSTed form.
      const parts = req.path.split('/').filter(Boolean);
      const password = XTREAM_ROOTS.has(String(parts[0]).toLowerCase())
        ? (parts[2] !== undefined ? decode(parts[2]) : undefined)
        : (req.query.password ?? req.body?.password);
      if (password !== undefined && password !== '') {
        grant = check(req, String(password));
        if (grant === 'full' || grant === 'share') req.accessPrefix = sharePrefix;
      }
    }
    if (grant === 'locked') return tooMany(req, res);
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
      const grant = check(req, String(req.body?.key ?? ''));
      if (grant === 'locked') return tooMany(req, res);
      if (grant !== 'full') {
        logger.warn(TAG, `${req.ip}: web sign-in with a wrong access key`);
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

  return { enabled, shareToken, stripPrefix, gate, routes };
}

module.exports = { createAccess, levelFor, normalPath };
