'use strict';

// Solo only (SOLO=1): what the app tells the server about the device.
//
//   PUT /api/solo/network { lanHost }   the device's Wi-Fi address (an IP), or
//                                       null without Wi-Fi — the cast listener
//                                       listens there (lib/soloCast.js)
//
// Behind the access gate like the rest of /api: the app's own key, not the
// share token.

const express = require('express');
const log = require('../logger');

function soloRoutes(soloCast) {
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

  return router;
}

/** Adds the routes under /api/solo — in Solo only; elsewhere they don't exist. */
function mount(app, config, soloCast) {
  if (config.solo) app.use('/api/solo', soloRoutes(soloCast));
}

module.exports = { soloRoutes, mount };
