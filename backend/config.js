// config.js — centralised configuration loaded from environment variables

const path = require('path');

const config = {
  port: parseInt(process.env.PORT || '8983', 10),
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
