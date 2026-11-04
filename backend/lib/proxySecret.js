'use strict';

// The key that signs the proxy's rewritten stream URLs (routes/proxy.js),
// kept in the data folder so the links an open player holds still work after
// a restart or a redeploy. Made on first use; a missing, damaged or unwritable
// file just means a fresh key (players then reconnect, as before).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger');

const FILE = 'proxy-secret';
const BYTES = 32;

function loadProxySecret(dir) {
  const file = path.join(dir, FILE);
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* not there yet */ }
  const secret = crypto.randomBytes(BYTES);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  } catch (e) {
    log.warn('proxy', `couldn't save the stream link key (${e.message}) — open players reconnect after a restart`);
  }
  return secret;
}

module.exports = { loadProxySecret };
