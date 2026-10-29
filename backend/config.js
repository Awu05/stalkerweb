// config.js — centralised configuration loaded from environment variables

const path = require('path');

const solo = process.env.SOLO === '1';
const SOLO_HOST = '127.0.0.1';
if (solo && (process.env.HOST || '').trim() && process.env.HOST.trim() !== SOLO_HOST) {
  require('./logger').warn('config', `HOST=${process.env.HOST.trim()} is ignored in Solo — listening on ${SOLO_HOST} only`);
}

const config = {
  port: parseInt(process.env.PORT || '8983', 10),
  // The address to listen on: every address (IPv6 too, see server.js) — in
  // Solo only 127.0.0.1, so only the app reaches it. HOST isn't read: cast
  // and the server's own pulls go to 127.0.0.1, which another address breaks.
  host: solo ? SOLO_HOST : '0.0.0.0',
  // Solo: the server runs inside the StalkerWeb Solo Android app, and a second
  // listener on CAST_PORT gives a Chromecast the cast stream only (lib/soloCast.js).
  solo,
  castPort: solo ? parseInt(process.env.CAST_PORT || '0', 10) || 0 : 0,
  // Cast channels in memory (stalker/CastHls.js): pieces in each playlist, and
  // channels at once. A phone has less to spare: 6 and 1 there, 10 and 3 elsewhere.
  castWindow: solo ? 6 : 10,
  castMaxSessions: solo ? 1 : 3,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Optional HTTPS listener (see server.js): port plus PEM certificate and key.
  httpsPort: parseInt(process.env.HTTPS_PORT || '0', 10) || 0,
  httpsCert: process.env.HTTPS_CERT || '',
  httpsKey: process.env.HTTPS_KEY || '',
  // Optional access key (see lib/access.js). Unset = no login, as before.
  accessKey: (process.env.ACCESS_KEY || '').trim(),
  // Live delay buffer default, seconds (0 = off); Settings can override.
  liveBufferSeconds: Math.max(0, Math.min(120, parseInt(process.env.LIVE_BUFFER_SECONDS || '0', 10) || 0)),
};

config.cacheDir = path.join(config.dataDir, 'cache');
config.configFile = path.join(config.dataDir, 'config.json');
// Default VOD download destination — overridable per-install via env var, and
// further overridable at runtime via Settings (see routes/settings.js).
config.downloadDir = process.env.DOWNLOAD_DIR || path.join(config.dataDir, 'downloads');

module.exports = config;
