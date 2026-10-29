'use strict';

// Casting in Solo (SOLO=1), where the server runs on the phone or TV itself.
// There it listens only on 127.0.0.1, for the app — but a Chromecast fetches
// the stream itself, from across the Wi-Fi. So while something is being cast,
// a second listener, on the phone's Wi-Fi address and a port the system picks
// each time it starts, answers that and nothing else: reading the stream,
// /k/<castToken>/proxy/… — no web app, no API, no settings, whatever the key.
//
// Each cast link gets a cast token of its own (castLink.js asks for one), and
// a token opens only what it was made for: the link's own path, and the links
// the server hands out while answering under it — the pieces in a playlist it
// sends (rewritten HLS, the cast channel's seg<n>.ts) and where a redirect
// sends the TV (a channel passed through to its own HLS) — and the poster the
// cast link was made with (/api/logos/render?…), which the TV shows while it
// plays. Those are all the ways this server hands the TV a link: the cast
// routes answer with playlists and redirects, a movie (/proxy/vod/stream) is
// its own link or an HLS playlist; nothing hands one out in JSON or HTML to
// the TV. Anything else under
// it is a 404, like everything else on the listener; so a link for one
// channel opens neither another channel nor a movie. The tokens are good only
// on the listener that made them: not the share token, which works on
// 127.0.0.1 too and never changes.
//
// The listener starts when the app asks for a cast link, and stops once
// nothing has been asked of it for 10 minutes and no channel is being cast
// (a stranger's refused request doesn't count as asking);
// the next cast link starts it again, with new tokens. While the app says a
// cast is on (PUT /api/solo/casting — a paused movie asks for nothing for
// as long as it's paused), it doesn't stop for that, for up to 6 hours without
// a request. The app sends the Wi-Fi address when it changes (PUT
// /api/solo/network, routes/solo.js) — this server can't tell which of the
// device's addresses the TV can reach — and a listener that's up moves to the
// new one.
//
// Inside, a request it lets through is handed to the app as if it came under
// the share token, so the access check needs nothing new; but the links in
// what it answers (a playlist's pieces, a redirect) carry the cast token
// (lanLinks, after the access middleware), so the share token never leaves
// the device.

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const log = require('../logger');
const TAG = 'solo';
const IDLE_MS = 10 * 60 * 1000;
const CASTING_MAX_MS = 6 * 3600 * 1000;   // "a cast is on" holds the listener this long without a request
const MAX_TOKENS = 32;                    // cast links kept good on one listener; the oldest goes
const MAX_PATHS = 4096;                   // links kept open under one token (a playlist's pieces come and go)
const SCAN_MAX = 2 * 1024 * 1024;         // a playlist bigger than this isn't read for its links

// Set on a request that came in on the cast listener: the prefix its links carry.
const LAN_PREFIX = Symbol('soloCastPrefix');

let setup = null;      // { app, shareToken, castSessions, idleMs, castingMaxMs, logger } — set by enable()
let lanHost = null;    // the device's Wi-Fi address, as the app last said
let listener = null;   // the cast listener while it's starting or up
let casting = null;    // { since } while the app says a cast is on
let lastLan = 0;       // when the listener was last asked for something

/**
 * Casting on in Solo: cast links go through the cast listener from now on.
 * Without a share token (no ACCESS_KEY) there'd be nothing it could let
 * through, so casting stays off. `castSessions` says how many channels are
 * being cast — the listener isn't stopped under one. A `port` is ignored:
 * the listener takes whichever port is free each time it starts.
 */
function enable({ app, shareToken, castSessions = () => 0, idleMs = IDLE_MS, castingMaxMs = CASTING_MAX_MS, logger = log }) {
  disable();
  if (!shareToken) {
    logger.warn(TAG, 'Solo without an ACCESS_KEY — the cast listener is not started, so casting is off');
    return false;
  }
  setup = { app, shareToken, castSessions, idleMs, castingMaxMs, logger };
  return true;
}

/** Casting off: the listener (if up) stops and the Wi-Fi address is forgotten. */
function disable() {
  if (listener) stop(listener, 'shutting down');
  setup = null;
  lanHost = null;
  casting = null;
}

/** Whether cast links go through the cast listener (Solo), Wi-Fi or not. */
const active = () => !!setup;

/** Whether a value can be the Wi-Fi address: a plain IPv4 or IPv6 address, nothing else. */
function isLanHost(host) {
  return typeof host === 'string' && (net.isIPv4(host) || (net.isIPv6(host) && !host.includes('%')));
}

/**
 * The device's Wi-Fi address, or null with no Wi-Fi; anything else counts as
 * none. A listener that's up moves to the new address (with new tokens), or
 * stops without one. Returns whether the address changed.
 */
function setLanHost(host) {
  const next = isLanHost(host) ? host : null;
  if (next === lanHost) return false;
  lanHost = next;
  if (listener) {
    stop(listener, next ? 'the Wi-Fi address changed' : 'no Wi-Fi');
    if (next && setup) start();
  }
  return true;
}

const getLanHost = () => lanHost;

/**
 * The app says a cast is on (a movie, maybe paused) or over. While it's on
 * the listener doesn't stop for want of requests — until 6 hours pass
 * without one; over, the 10 minutes count again from now.
 */
function setCasting(on) {
  casting = on ? { since: Date.now() } : null;
  if (listener) armIdle(listener);
}

/** Whether the app's "a cast is on" still holds (said, and not past the 6 hours). */
function castingActive() {
  if (!casting || !setup) return false;
  if (Date.now() - Math.max(casting.since, lastLan) < setup.castingMaxMs) return true;
  setup.logger.info(TAG, 'a cast was on, but nothing was asked of the listener for hours — counting it as over');
  casting = null;
  return false;
}

const hostPart = (h) => (net.isIPv6(h) ? `[${h}]` : h);

/** Where a cast device reaches the listener now — http://<lanHost>:<port> — or null. */
function castOrigin() {
  const l = listener;
  return l && l.up ? `http://${hostPart(l.host)}:${l.port}` : null;
}

/** A path and query as the TV will ask for it (the URL parser's spelling), or null. */
function normalPath(pathAndQuery) {
  try {
    const u = new URL(pathAndQuery, 'http://cast.invalid');
    return u.host === 'cast.invalid' ? u.pathname + u.search : null;
  } catch { return null; }
}

/** Whether a path is a poster the server renders (/api/logos/render?…), the only image a cast token may open. */
function isCastImage(pathAndQuery) {
  return typeof pathAndQuery === 'string' && pathAndQuery.length <= 4096
    && pathAndQuery.startsWith('/api/logos/render?') && normalPath(pathAndQuery) === pathAndQuery;
}

/**
 * The cast listener, started if it isn't up (on the Wi-Fi address), and a new
 * cast token on it that opens `pathAndQuery` (/proxy/…) — and `image`, a
 * poster (isCastImage), when given: resolves to
 * http://<lanHost>:<port>/k/<castToken>, or null without Wi-Fi or when it
 * couldn't start. Asking again while it's up keeps it up a while longer. A
 * listener that moves meanwhile (the Wi-Fi address changed) is waited for.
 */
async function ensureListener(pathAndQuery, { image = null } = {}) {
  let l = null;
  for (let tries = 0; tries < 3; tries++) {
    if (!setup || !lanHost) return null;
    if (!listener) start();
    else armIdle(listener);
    l = listener;
    await l.ready;
    if (listener === l && l.up) break;
    if (!listener) return null;   // it couldn't start, or there's no Wi-Fi now
  }
  if (listener !== l || !l.up) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  const grant = new Map();
  const link = normalPath(pathAndQuery);
  if (link) grant.set(link, true);   // true: kept however many pieces come after
  if (isCastImage(image)) grant.set(image, true);
  l.tokens.set(token, grant);
  while (l.tokens.size > MAX_TOKENS) l.tokens.delete(l.tokens.keys().next().value);
  return `${castOrigin()}/k/${token}`;
}

/** Where the listener is bound ({ address, port }), or null — for the tests. */
function listenerAddress() {
  return listener?.up ? listener.server.address() : null;
}

function start() {
  const { app, shareToken, logger } = setup;
  const l = {
    host: lanHost, port: 0, tokens: new Map(),   // castToken → its open paths (path → pinned)
    up: false, inflight: 0, timer: null, server: null, ready: null, settle: () => {},
  };
  const gate = lanGate(l, shareToken);
  l.server = http.createServer((req, res) => {
    // Only what's let through counts as the TV asking (keeps it up).
    gate(req, res, () => {
      l.inflight++;
      res.once('close', () => { l.inflight--; armIdle(l); });
      app(req, res);
    });
  });
  l.ready = new Promise((resolve) => {
    l.settle = resolve;   // stopped before it was up: whoever waits gets null
    l.server.once('listening', () => {
      l.up = true;
      l.port = l.server.address().port;
      logger.info(TAG, `cast stream on ${hostPart(l.host)}:${l.port} — only the cast stream, under tokens of its own`);
      armIdle(l);
      resolve();
    });
    l.server.on('error', (e) => {
      logger.error(TAG, `cast listener on ${hostPart(l.host)} failed (${e.code || e.message}) — casting is off`);
      stop(l, null);
      resolve();
    });
  });
  l.server.listen(0, l.host);   // a free port, the system's pick
  listener = l;
}

/**
 * The listener stops after the idle time — unless a request is still open, a
 * channel is being cast, or the app says a cast is on.
 */
function armIdle(l) {
  if (!setup || listener !== l || !l.up) return;
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    if (listener !== l) return;
    if (l.inflight > 0 || setup.castSessions() > 0 || castingActive()) return armIdle(l);
    stop(l, 'nothing cast for a while');
  }, setup.idleMs);
  l.timer.unref?.();
}

function stop(l, why) {
  clearTimeout(l.timer);
  if (listener === l) listener = null;
  if (l.up && why) setup?.logger.info(TAG, `cast listener stopped — ${why}`);
  l.up = false;
  l.tokens.clear();
  l.settle();
  try { l.server.close(); } catch { /* not listening */ }
  l.server.closeAllConnections?.();
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The open paths of the cast token a request carries, or null. Every token is compared, in constant time. */
function grantFor(l, token) {
  let found = null;
  for (const [t, grant] of l.tokens) if (sameSecret(token, t)) found = grant;
  return found;
}

/** Opens a path under a token: the newest last, the oldest unpinned one going past MAX_PATHS. */
function allow(grant, path) {
  if (grant.has(path)) {
    if (grant.get(path)) return;   // the link itself stays where it is
    grant.delete(path);
  }
  grant.set(path, false);
  if (grant.size <= MAX_PATHS) return;
  for (const [p, pinned] of grant) {
    if (!pinned) { grant.delete(p); return; }
  }
}

/**
 * Notes the links a response hands out under a cast token — where a redirect
 * points, and the URIs in a playlist (each line that isn't a tag, and URI="…"
 * in tags) — so the TV may open them next. Links are taken as the TV takes
 * them: against the URL it asked for, and only those back to this listener,
 * under the same token. A playlist is read line by line as it's written, so a
 * piece is open before the TV can read its name.
 */
function watchLinks(req, res, url, prefix, grant) {
  const base = new URL(url, 'http://cast.invalid');
  const host = String(req.headers.host || '');
  const note = (link) => {
    let u;
    try { u = new URL(link, base); } catch { return; }
    if (u.host !== 'cast.invalid' && u.host !== host) return;
    const p = u.pathname + u.search;
    if (p.startsWith(`${prefix}/proxy/`)) allow(grant, p.slice(prefix.length));
  };
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (String(name).toLowerCase() === 'location') note(String(value));
    return setHeader.call(this, name, value);
  };
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const headers = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
    for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === 'location') note(String(v));
    return writeHead.apply(this, args);
  };
  let carry = '';
  let seen = 0;
  const scan = (chunk, encoding, last) => {
    if (seen > SCAN_MAX || !/mpegurl/i.test(String(res.getHeader('content-type') || ''))) return;
    if (chunk != null && typeof chunk !== 'function') {
      const text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
        : String(chunk);
      seen += text.length;
      carry += text;
    }
    const lines = carry.split(/\r?\n/);
    carry = last ? '' : lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) for (const m of line.matchAll(/URI="([^"]+)"/gi)) note(m[1]);
      else note(line);
    }
  };
  const write = res.write;
  res.write = function (chunk, encoding, cb) {
    scan(chunk, encoding, false);
    return write.call(this, chunk, encoding, cb);
  };
  const end = res.end;
  res.end = function (chunk, encoding, cb) {
    scan(chunk, encoding, true);
    return end.call(this, chunk, encoding, cb);
  };
}

/**
 * In front of the app on the cast listener: only reading the stream under a
 * cast token gets through — and only what that token opens; and the CORS
 * preflight a receiver may send before it, which cors() in the app answers;
 * anything else is a bare 404, as if nothing were there. Judged on the raw
 * path, before the access middleware — and strictly: an escaped or
 * upper-case spelling, or a "..", is refused rather than worked out (the TV
 * only ever asks for the links it was given). What gets through goes on under
 * the share token, marked with the cast token's prefix for lanLinks. Plain
 * Node calls, so it can sit in front of the app without Express.
 */
function lanGate(l, shareToken) {
  return function soloLanGate(req, res, next) {
    const url = String(req.url || '');
    const p = url.split('?')[0];
    const m = /^\/k\/([^/]+)\/(?:proxy|api\/logos)\//.exec(p);
    const grant = m && shareToken ? grantFor(l, m[1]) : null;
    const rest = m ? url.slice(3 + m[1].length) : '';
    const ok = !!grant
      && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
      && !p.includes('%') && !p.includes('\\')
      && !p.split('/').some((s) => s === '..' || s === '.')
      && grant.has(normalPath(rest));
    if (ok) {
      lastLan = Date.now();   // a cast device still at it (not a stranger's 404)
      const prefix = `/k/${m[1]}`;
      watchLinks(req, res, url, prefix, grant);
      req.url = `/k/${shareToken}${rest}`;
      req[LAN_PREFIX] = prefix;
      return next();
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not found');
  };
}

/**
 * Right after the access middleware: a request from the cast listener hands
 * out links under the cast token, not the share token it was let in under
 * (publicUrl.baseUrl reads req.accessPrefix).
 */
function lanLinks(req, _res, next) {
  if (req[LAN_PREFIX]) req.accessPrefix = req[LAN_PREFIX];
  next();
}

module.exports = {
  enable, disable, active, isLanHost, setLanHost, getLanHost, setCasting, castingActive,
  castOrigin, ensureListener, isCastImage, listenerAddress, lanLinks, IDLE_MS, CASTING_MAX_MS,
};
