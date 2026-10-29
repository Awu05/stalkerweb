'use strict';

// Casting in Solo (SOLO=1), where the server runs on the phone or TV itself.
// There it listens only on 127.0.0.1, for the app — but a Chromecast fetches
// the stream itself, from across the Wi-Fi. So while something is being cast,
// a second listener, on the phone's Wi-Fi address and its own port
// (CAST_PORT), answers that and nothing else: reading the stream,
// /k/<castToken>/proxy/… — no web app, no API, no settings, whatever the key.
//
// The cast token is made afresh each time the listener starts, and is good
// only on it: not the share token, which works on 127.0.0.1 too and never
// changes. The listener starts when the app asks for a cast link (castLink.js),
// and stops once nothing has been asked of it for 10 minutes and no channel is
// being cast; the next cast link starts it again, with a new token. The app
// sends the Wi-Fi address when it changes (PUT /api/solo/network,
// routes/solo.js) — this server can't tell which of the device's addresses the
// TV can reach — and a listener that's up moves to the new one.
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

// Set on a request that came in on the cast listener: the prefix its links carry.
const LAN_PREFIX = Symbol('soloCastPrefix');

let setup = null;      // { app, port, shareToken, castSessions, idleMs, logger } — set by enable()
let lanHost = null;    // the device's Wi-Fi address, as the app last said
let listener = null;   // the cast listener while it's starting or up

/**
 * Casting on in Solo: cast links go through the cast listener from now on.
 * Without a share token (no ACCESS_KEY) there'd be nothing it could let
 * through, so casting stays off. `castSessions` says how many channels are
 * being cast — the listener isn't stopped under one.
 */
function enable({ app, port, shareToken, castSessions = () => 0, idleMs = IDLE_MS, logger = log }) {
  disable();
  if (!shareToken) {
    logger.warn(TAG, 'Solo without an ACCESS_KEY — the cast listener is not started, so casting is off');
    return false;
  }
  setup = { app, port, shareToken, castSessions, idleMs, logger };
  return true;
}

/** Casting off: the listener (if up) stops and the Wi-Fi address is forgotten. */
function disable() {
  if (listener) stop(listener, 'shutting down');
  setup = null;
  lanHost = null;
}

/** Whether cast links go through the cast listener (Solo), Wi-Fi or not. */
const active = () => !!setup;

/** Whether a value can be the Wi-Fi address: a plain IPv4 or IPv6 address, nothing else. */
function isLanHost(host) {
  return typeof host === 'string' && (net.isIPv4(host) || (net.isIPv6(host) && !host.includes('%')));
}

/**
 * The device's Wi-Fi address, or null with no Wi-Fi; anything else counts as
 * none. A listener that's up moves to the new address (with a new token), or
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

const hostPart = (h) => (net.isIPv6(h) ? `[${h}]` : h);

/** Where a cast device reaches the stream now — http://<lanHost>:<port>/k/<castToken> — or null. */
function castBase() {
  const l = listener;
  return l && l.up ? `http://${hostPart(l.host)}:${l.port}/k/${l.token}` : null;
}

/**
 * The cast listener, started if it isn't up (on the Wi-Fi address, with a new
 * token): resolves to castBase(), or null without Wi-Fi or when it couldn't
 * start. Asking again while it's up keeps it up a while longer.
 */
async function ensureListener() {
  if (!setup || !lanHost) return null;
  if (!listener) start();
  else armIdle(listener);
  const l = listener;
  await l.ready;
  return listener === l ? castBase() : null;
}

/** Where the listener is bound ({ address, port }), or null — for the tests. */
function listenerAddress() {
  return listener?.up ? listener.server.address() : null;
}

function start() {
  const { app, port, shareToken, logger } = setup;
  const l = {
    host: lanHost, port: 0, token: crypto.randomBytes(24).toString('base64url'),
    up: false, inflight: 0, timer: null, server: null, ready: null, settle: () => {},
  };
  const gate = lanGate(l.token, shareToken);
  l.server = http.createServer((req, res) => {
    l.inflight++;
    res.once('close', () => { l.inflight--; armIdle(l); });
    gate(req, res, () => app(req, res));
  });
  l.ready = new Promise((resolve) => {
    l.settle = resolve;   // stopped before it was up: whoever waits gets null
    l.server.once('listening', () => {
      l.up = true;
      l.port = l.server.address().port;
      logger.info(TAG, `cast stream on ${hostPart(l.host)}:${l.port} — only the cast stream, under a new token`);
      armIdle(l);
      resolve();
    });
    l.server.on('error', (e) => {
      logger.error(TAG, `cast listener on ${hostPart(l.host)}:${port} failed (${e.code || e.message}) — casting is off`);
      stop(l, null);
      resolve();
    });
  });
  l.server.listen(port, l.host);
  listener = l;
}

/** The listener stops after the idle time — unless a request is still open or a channel is being cast. */
function armIdle(l) {
  if (!setup || listener !== l || !l.up) return;
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    if (listener !== l) return;
    if (l.inflight > 0 || setup.castSessions() > 0) return armIdle(l);
    stop(l, 'nothing cast for a while');
  }, setup.idleMs);
  l.timer.unref?.();
}

function stop(l, why) {
  clearTimeout(l.timer);
  if (listener === l) listener = null;
  if (l.up && why) setup?.logger.info(TAG, `cast listener stopped — ${why}`);
  l.up = false;
  l.settle();
  try { l.server.close(); } catch { /* not listening */ }
  l.server.closeAllConnections?.();
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * In front of the app on the cast listener: only reading the stream under the
 * cast token gets through — and the CORS preflight a receiver may send before
 * it, which cors() in the app answers; anything else is a bare 404, as if
 * nothing were there. Judged on the raw path, before the access middleware —
 * and strictly: an escaped or upper-case spelling, or a "..", is refused
 * rather than worked out (the TV only ever asks for the links it was given).
 * What gets through goes on under the share token, marked with the cast
 * token's prefix for lanLinks. Plain Node calls, so it can sit in front of the
 * app without Express.
 */
function lanGate(castToken, shareToken) {
  const castPrefix = `/k/${castToken}`;
  return function soloLanGate(req, res, next) {
    const url = String(req.url || '');
    const p = url.split('?')[0];
    const m = /^\/k\/([^/]+)\/proxy\//.exec(p);
    const ok = !!castToken && !!shareToken && !!m && sameSecret(m[1], castToken)
      && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
      && !p.includes('%') && !p.includes('\\')
      && !p.split('/').some((s) => s === '..' || s === '.');
    if (ok) {
      req.url = `/k/${shareToken}${url.slice(3 + m[1].length)}`;
      req[LAN_PREFIX] = castPrefix;
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
  enable, disable, active, isLanHost, setLanHost, getLanHost, castBase, ensureListener, listenerAddress,
  lanGate, lanLinks, IDLE_MS,
};
