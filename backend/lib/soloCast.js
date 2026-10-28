'use strict';

// Casting in Solo (SOLO=1), where the server runs on the phone or TV itself.
// There it listens only on 127.0.0.1, for the app — but a Chromecast fetches
// the stream itself, from across the Wi-Fi. So a second listener, on every
// address and its own port (CAST_PORT), answers that and nothing else: reading
// the stream under the playback-only share token, /k/<token>/proxy/… — no web
// app, no API, no settings, whatever the key. Cast links then point at it, on
// the phone's Wi-Fi address, which the app sends when it changes
// (PUT /api/solo/network, routes/solo.js): this server can't tell which of the
// device's addresses the TV can reach.

const http = require('http');
const net = require('net');
const log = require('../logger');
const TAG = 'solo';

let castPort = 0;      // the cast listener's port while it's up; 0 = none
let lanHost = null;    // the device's Wi-Fi address, as the app last said

/** The port the cast listener is on; 0 = it isn't (set by startLanListener). */
function setCastPort(port) {
  castPort = Number.isInteger(port) && port > 0 ? port : 0;
}

/** Whether a value can be the Wi-Fi address: a plain IPv4 or IPv6 address, nothing else. */
function isLanHost(host) {
  return typeof host === 'string' && (net.isIPv4(host) || (net.isIPv6(host) && !host.includes('%')));
}

/** The device's Wi-Fi address, or null with no Wi-Fi. Anything else is ignored. */
function setLanHost(host) {
  lanHost = isLanHost(host) ? host : null;
}

/** Where a cast device reaches this server — http://<lanHost>:<castPort> — or null without one. */
function castOrigin() {
  if (!castPort || !lanHost) return null;
  return `http://${net.isIPv6(lanHost) ? `[${lanHost}]` : lanHost}:${castPort}`;
}

/** Whether cast links go through the cast listener (Solo), Wi-Fi or not. */
const active = () => castPort > 0;

/**
 * In front of the app on the cast listener: only reading the stream under the
 * share token gets through — and the CORS preflight a receiver may send before
 * it, which cors() in the app answers; anything else is a bare 404, as if
 * nothing were there. Judged on the raw path, before the access middleware takes the prefix
 * off — and strictly: an escaped or upper-case spelling, or a "..", is refused
 * rather than worked out (the TV only ever asks for the links it was given).
 * Plain Node calls, so it can sit in front of the app without Express.
 */
function lanGate(shareToken) {
  const prefix = `/k/${shareToken}/proxy/`;
  return function soloLanGate(req, res, next) {
    const p = String(req.url || '').split('?')[0];
    const ok = !!shareToken
      && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
      && p.startsWith(prefix)
      && !p.includes('%') && !p.includes('\\')
      && !p.split('/').some((s) => s === '..' || s === '.');
    if (ok) return next();
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not found');
  };
}

/**
 * The cast listener: the app, behind lanGate, on host:port — by default every
 * address, IPv4 and IPv6 ('::'; just IPv4 on a system without IPv6), since the
 * Wi-Fi address the app sends may be either. Without a share token (no
 * ACCESS_KEY) there'd be nothing it could let through, so it isn't started.
 * Cast links point at it only while it's listening (castOrigin()): one that
 * failed to start, or stopped, gives links marked unreachable. Returns the
 * server, or null.
 */
function startLanListener({ app, port, host, shareToken, logger = log }) {
  castPort = 0;
  if (!shareToken) {
    logger.warn(TAG, 'Solo without an ACCESS_KEY — the cast listener is not started, so casting is off');
    return null;
  }
  const gate = lanGate(shareToken);
  const server = http.createServer((req, res) => gate(req, res, () => app(req, res)));
  let bind = host || '::';
  let up = false;
  const down = () => { if (up) { up = false; castPort = 0; } };
  server.on('listening', () => {
    up = true;
    castPort = server.address().port;
    logger.info(TAG, `cast stream on port ${castPort}${bind === '::' ? '' : ` (${bind})`} — only the cast stream`);
  });
  server.on('error', (e) => {
    if (!host && bind === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) {
      bind = '0.0.0.0';   // no IPv6 here
      return server.listen(port, bind);
    }
    down();
    logger.error(TAG, `cast listener on port ${port} failed (${e.code || e.message}) — casting is off`);
  });
  server.on('close', down);
  server.listen(port, bind);
  return server;
}

module.exports = { setCastPort, setLanHost, isLanHost, castOrigin, active, lanGate, startLanListener };
