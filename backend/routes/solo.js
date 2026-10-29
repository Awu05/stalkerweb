'use strict';

// Solo only (SOLO=1): what the app and the server tell each other about the device.
//
//   PUT /api/solo/network { lanHost }   the device's Wi-Fi address (an IP), or
//                                       null without Wi-Fi — the cast listener
//                                       listens there (lib/soloCast.js)
//   PUT /api/solo/casting { active }    a cast is on (true) or over (false):
//                                       while on, the cast listener doesn't
//                                       stop for want of requests (a paused
//                                       movie), for up to 6 hours without one
//   GET /api/solo/status                { downloadsActive, castActive } — what
//                                       still needs the server, for the app's
//                                       keep-alive when it comes back after
//                                       Android stopped it
//
// Behind the access gate like the rest of /api: the app's own key, not the
// share token.
//
// And on the open GET /api/health, in Solo: ?nonce=<16–128 of A-Z a-z 0-9 _ ->
// adds `proof`, HMAC-SHA256 of "solo-health:<nonce>" keyed with the access
// key (hex). The app starts each server on a port it picked; until the one
// there has proved it holds the key, the app doesn't send it the key — so a
// stranger who took the old port gets nothing.

const crypto = require('crypto');
const express = require('express');
const log = require('../logger');

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/** The proof /api/health gives for a nonce in Solo, or null (no key, or not a nonce). */
function healthProof(key, nonce) {
  if (!key || typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
  return crypto.createHmac('sha256', key).update(`solo-health:${nonce}`).digest('hex');
}

/**
 * @param {object} soloCast  lib/soloCast.js
 * @param {object} [o]
 * @param {() => boolean} [o.downloadsActive]  a download queued or running
 * @param {() => number} [o.castSessions]      channels being cast (stalker/CastHls.js)
 */
function soloRoutes(soloCast, { downloadsActive = () => false, castSessions = () => 0 } = {}) {
  const router = express.Router();

  router.put('/network', (req, res) => {
    const lanHost = req.body?.lanHost;
    if (lanHost !== null && !soloCast.isLanHost(lanHost)) {
      return res.status(400).json({ error: 'lanHost must be an IP address, or null without Wi-Fi' });
    }
    if (soloCast.setLanHost(lanHost)) {
      log.info('solo', lanHost ? `Wi-Fi address ${lanHost} — cast links go there` : 'no Wi-Fi address — casting needs Wi-Fi');
    }
    res.status(204).end();
  });

  router.put('/casting', (req, res) => {
    const on = req.body?.active;
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
    soloCast.setCasting(on);
    res.status(204).end();
  });

  router.get('/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      downloadsActive: !!downloadsActive(),
      castActive: castSessions() > 0 || soloCast.castingActive(),
    });
  });

  return router;
}

/** Adds the routes under /api/solo — in Solo only; elsewhere they don't exist. */
function mount(app, config, soloCast, deps) {
  if (config.solo) app.use('/api/solo', soloRoutes(soloCast, deps));
}

module.exports = { soloRoutes, mount, healthProof };
