'use strict';

// The key that signs the proxy's rewritten stream URLs (routes/proxy.js),
// kept in the data folder so the links an open player holds still work after
// a restart or a redeploy. Made when the file is missing or damaged, written
// whole through a temporary file (owner-only) renamed into place. A file that
// is there but can't be read right now (a lock, a sync client) is left alone:
// this run uses a key of its own, and the next one reads the file again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger');

const FILE = 'proxy-secret';
const BYTES = 32;

function loadProxySecret(dir) {
  const file = path.join(dir, FILE);
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn('proxy', `couldn't read the stream link key (${e.code || e.message}) — using a temporary one; open players reconnect after a restart`);
      return crypto.randomBytes(BYTES);
    }
  }
  if (text !== null && new RegExp(`^[0-9a-f]{${BYTES * 2}}$`, 'i').test(text)) return Buffer.from(text, 'hex');

  const secret = crypto.randomBytes(BYTES);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, secret.toString('hex'), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn('proxy', `couldn't save the stream link key (${e.message}) — open players reconnect after a restart`);
  }
  return secret;
}

module.exports = { loadProxySecret, BYTES };
