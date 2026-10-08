'use strict';

// When stdout/stderr are pipes (Docker, CI) Node.js may buffer writes and
// drop them on crash. Force synchronous (blocking) I/O so every console.log
// line appears immediately in `docker logs`.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
if (process.stderr._handle?.setBlocking) process.stderr._handle.setBlocking(true);

// Prefer IPv4 when resolving hostnames. Many logo/stream CDNs publish AAAA
// records that are unroutable from inside a Docker container, causing a
// multi-second connect hang then failure. ipv4first makes Node try the A
// record first. (Node 18+.)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* older Node */ }

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Ensure data directories exist
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

const app = express();

// Trust the first reverse-proxy hop (Caddy / nginx / Traefik).
// Without this, req.protocol is always 'http' even behind HTTPS termination,
// which causes rewriteM3u8() to emit http:// proxy URLs that the browser
// blocks as mixed content when the public URL is served over HTTPS.
app.set('trust proxy', 1);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
  // With the built-in HTTPS listener, HTTP stays up on another port of the same
  // host. HSTS is per host, not per port, so a browser that saw it over HTTPS
  // would force HTTPS onto the HTTP port and break it.
  strictTransportSecurity: config.httpsPort ? false : undefined,
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Shared application state (single active session) ──────────────────────
const appState = {
  client: null,
  sessionManager: null,
  channelManager: null,
  guideManager: null,
  vodManager: null,
  identity: null,
};

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    connected: !!(appState.sessionManager?.isAuthenticated()),
    version: config.version || require('./package.json').version,
  });
});

// ── API Routes ─────────────────────────────────────────────────────────────
// auth module exports { authRoutes, connectPortal } so server can call
// connectPortal() directly at startup without a mock HTTP request.
const LogoManager = require('./logos/LogoManager');
const logoManager = new LogoManager(config.dataDir);
logoManager.ensureLoadedBackground();

const FavoritesManager = require('./favorites/FavoritesManager');
const favoritesManager = new FavoritesManager(config.dataDir);

const ProfilesManager = require('./profiles/ProfilesManager');
const profilesManager = new ProfilesManager(config.dataDir);
// Exposed on appState so routes that filter by the active profile's hidden
// languages (VOD categories) can reach it without a second constructor arg.
appState.profilesManager = profilesManager;

// Filter applied to the M3U / XMLTV / XSPF exports: the active profile's hidden
// genres and languages, plus adult channels unless Show Adult Content is on.
// Read per request, so a change in Settings applies to the next export.
const { buildExportFilter } = require('./lib/exportFilter');
const exportSettingsCache = new (require('./cache/CacheManager'))(config.dataDir);
appState.getExportFilter = () => buildExportFilter({
  profile:   profilesManager.getActive(),
  showAdult: exportSettingsCache.load()?.show_adult === true,
});
appState.getShowAdult = () => exportSettingsCache.load()?.show_adult === true;

const { authRoutes, connectPortal } = require('./routes/auth')(appState, config);

// ── Idle auto-disconnect ───────────────────────────────────────────────────
// Tear down the session after the idle timeout of no stream/proxy activity.
const log = require('./logger');

// ── HTTP request logger ────────────────────────────────────────────────────
// Classifies each request so the console shows what actually matters:
//   • errors (4xx/5xx)            → always, as warn/error
//   • real API calls + stream     → info (visible at the default level)
//   • high-frequency / SSE / poll  → debug only
//   • health probes, SPA shell,    → never logged on success (pure flood —
//     static assets                  this was the "GET / 200" noise)
const QUIET_EXACT  = new Set(['/', '/index.html', '/status', '/favicon.ico', '/api/health']);
const QUIET_PREFIX = ['/api/channels/progress', '/api/channels/events', '/api/logs', '/assets/'];
const STATIC_EXT   = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|webmanifest|txt)$/i;

function httpLogLevel(path, status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  if (QUIET_EXACT.has(path) || STATIC_EXT.test(path)) return null;           // skip on success
  if (path.startsWith('/proxy/hls') ||                                       // segments/sub-playlists
      QUIET_PREFIX.some(p => path.startsWith(p))) return 'debug';
  return 'info';                                                             // API + stream starts
}

app.use((req, res, next) => {
  const start = Date.now();
  // Snapshot req.url NOW — Express strips the sub-router mount prefix (/proxy)
  // from req.url before calling the route handler, so reading it inside the
  // 'finish' callback would give "/hls?…" instead of "/proxy/hls?…", breaking
  // the httpLogLevel quiet-path check and causing HLS playlist poll spam at INFO.
  const url = req.url;
  res.on('finish', () => {
    const path  = url.split('?')[0];
    const level = httpLogLevel(path, res.statusCode);
    if (!level) return;
    const ms = Date.now() - start;
    log[level]('http', `${req.method.padEnd(4)} ${url}  ${res.statusCode}  ${ms}ms`);
  });
  next();
});

// Timeout comes from IDLE_TIMEOUT_MINUTES, overridden by a value saved on the
// Settings page (see routes/settings.js). 0 = never auto-disconnect.
const { parseIdleMinutes, parseIdleEnv } = require('./lib/idleTimeout');
const envIdle          = parseIdleEnv(process.env.IDLE_TIMEOUT_MINUTES);
if (envIdle.warning) log.warn('server', envIdle.warning);
const envIdleMinutes   = envIdle.minutes;
const savedIdleMinutes = parseIdleMinutes(
  new (require('./cache/CacheManager'))(config.dataDir).load()?.idle_timeout_minutes, null);

function destroySession() {
  appState._idleTimer = null;
  if (!appState.sessionManager || !appState.idleTimeoutMs) return;
  // Never tear down while a stream connection is still open — playback is live.
  // Defer the check by one idle interval so the timer resumes once it closes.
  if (appState.activeStreams > 0) {
    log.debug('server', `idle timeout reached but ${appState.activeStreams} stream(s) active — deferring disconnect`);
    appState._idleTimer = setTimeout(destroySession, appState.idleTimeoutMs);
    return;
  }
  log.info('server', `idle timeout (${appState.idleTimeoutMs / 60000}m) — auto-disconnecting session`);
  appState.sessionManager.destroy();
  appState.sessionManager = null;
  appState.client = null;
  appState.channelManager = null;
  appState.guideManager = null;
  appState.vodManager = null;
  appState.identity = null;
}

// (Re)arm the disconnect timer so it fires idleTimeoutMs after the last
// activity — counting from lastActivityAt, so changing the timeout mid-session
// keeps the elapsed idle time instead of restarting the countdown.
function armIdleTimer() {
  clearTimeout(appState._idleTimer);
  appState._idleTimer = null;
  if (!appState.idleTimeoutMs) return;   // 0 = never
  const idleFor = appState.lastActivityAt ? Date.now() - Date.parse(appState.lastActivityAt) : 0;
  appState._idleTimer = setTimeout(destroySession, Math.max(0, appState.idleTimeoutMs - idleFor));
}

appState.idleTimeoutMs   = (savedIdleMinutes ?? envIdleMinutes) * 60 * 1000;
appState.lastActivityAt  = null;
appState._idleTimer      = null;
appState.activeStreams   = 0;      // open proxy stream connections (playback in progress)
appState._reconnecting   = null;   // serialise concurrent auto-reconnects
appState.connectPortal   = connectPortal;
appState.idleTimeoutDefaultMinutes = envIdleMinutes;

// Applies a timeout saved from the Settings page immediately — no restart.
appState.setIdleTimeoutMinutes = function setIdleTimeoutMinutes(minutes) {
  appState.idleTimeoutMs = minutes * 60 * 1000;
  log.info('server', minutes ? `idle timeout set to ${minutes}m` : 'idle auto-disconnect disabled');
  if (appState.sessionManager) armIdleTimer();
};

// Reconnects to the saved portal if the session is down (idle auto-disconnect,
// restart). Called where an outside client arrives without going through the
// web UI — stream links, playlists, the guide, the Xtream API, the Stremio
// addon — so those keep working after the idle disconnect. Not called for the
// web UI's own API polling, which would otherwise keep the session up forever.
// Concurrent callers share one attempt. Resolves true when connected; throws
// when there is no saved portal or the reconnect fails.
appState.ensureSession = async function ensureSession() {
  if (appState.sessionManager?.isAuthenticated() && appState.channelManager) return true;
  if (!appState._reconnecting) {
    const saved = new (require('./cache/CacheManager'))(config.dataDir).load();
    if (!saved?.portal || !saved?.mac) throw new Error('Not connected to a portal. Configure portal first.');
    log.info('server', 'session inactive — auto-reconnecting for an incoming request');
    appState._reconnecting = connectPortal(saved)
      .then(() => {
        log.info('server', 'auto-reconnect succeeded');
        appState.touchActivity();
      })
      .catch((e) => {
        log.error('server', `auto-reconnect failed: ${e.message}`);
        throw e;
      })
      .finally(() => { appState._reconnecting = null; });
  }
  await appState._reconnecting;
  return true;
};

appState.touchActivity = function touchActivity() {
  appState.lastActivityAt = new Date().toISOString();
  armIdleTimer();
};

// Attach a heartbeat to a long-lived proxy response so the idle-disconnect timer
// keeps resetting for as long as playback is actually flowing — independent of
// the player (web, Kodi, Jellyfin, VLC). Touches immediately, then every 60s
// while the connection is open, and once more on close so the 30-min grace
// window starts from the moment the last viewer leaves.
const STREAM_HEARTBEAT_MS = 60 * 1000;
appState.attachStreamHeartbeat = function attachStreamHeartbeat(req, res) {
  appState.activeStreams++;
  appState.touchActivity();
  const hb = setInterval(() => appState.touchActivity(), STREAM_HEARTBEAT_MS);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(hb);
    appState.activeStreams = Math.max(0, appState.activeStreams - 1);
    appState.touchActivity();
  };
  res.on('close', end);
  res.on('finish', end);
};

// ── Periodic state summary ─────────────────────────────────────────────────
// One-line snapshot of what the server is actually doing — but logged ONLY when
// it changes. An idle box stays silent; a connect, channel load, or stream
// start/stop surfaces immediately. This is the "what is happening" line you can
// scan for even when no requests are flowing.
let _lastSummary = '';
function logStateSummary() {
  const connected = !!appState.sessionManager?.isAuthenticated();
  if (!connected) {
    if (_lastSummary !== 'disconnected') { _lastSummary = 'disconnected'; log.info('state', 'portal disconnected'); }
    return;
  }
  let portal = '?';
  try { portal = new URL(appState.client.getBasePath()).host; } catch { /* ignore */ }
  const prog     = appState.channelManager?.getProgress?.() || {};
  const channels = appState.channelManager?.getChannels?.().length ?? 0;
  const loading  = prog.loading ? ` (loading ${prog.page}/${prog.totalPages})` : '';
  const streams  = appState.activeStreams || 0;
  const summary  = `portal=${portal} channels=${channels}${loading} streams=${streams}`;
  if (summary !== _lastSummary) { _lastSummary = summary; log.info('state', summary); }
}
const _summaryTimer = setInterval(logStateSummary, 10_000);
if (_summaryTimer.unref) _summaryTimer.unref();

const vodRoutes    = require('./routes/vod')(appState, config);

const DownloadManager = require('./downloads/DownloadManager');
const downloadsCache = new (require('./cache/CacheManager'))(config.dataDir);
const downloadManager = new DownloadManager(appState, () => downloadsCache.load()?.download_dir || config.downloadDir);
const downloadsRoutes = require('./routes/downloads')(downloadManager, appState);

const channelRoutes = require('./routes/channels')(appState);
const epgRoutes = require('./routes/epg')(appState);
const streamRoutes = require('./routes/stream')(appState, config);
const settingsRoutes = require('./routes/settings')(config, appState);
const proxyRoutes = require('./routes/proxy')(appState);
const m3uRoutes = require('./routes/m3u')(appState, logoManager);
const xspfRoutes = require('./routes/xspf')(appState, logoManager);
const xmltvRoutes = require('./routes/xmltv')(appState);
const logosRoutes     = require('./routes/logos')(logoManager, appState);
const favoritesRoutes = require('./routes/favorites')(favoritesManager, appState);
const profilesRoutes  = require('./routes/profiles')(profilesManager);
const exportRoutes    = require('./routes/export')(config);
const logsRoutes      = require('./routes/logs');
const XtreamIdStore   = require('./lib/XtreamIdStore');
const xtreamIdStore   = new XtreamIdStore(path.join(config.dataDir, 'xtream-episodes.json'));
// One catalog for the Xtream API and the Stremio addon, so they share filters
// and caches (lib/catalog.js).
const catalog         = require('./lib/catalog').createCatalog(appState, { logoManager, idStore: xtreamIdStore });
const xtreamRoutes    = require('./routes/xtream')(appState, {
  proxyRouter: proxyRoutes,
  m3uRouter:   m3uRoutes,
  xmltvRouter: xmltvRoutes,
  catalog,
});
const stremioRoutes   = require('./routes/stremio')(appState, {
  catalog,
  version: require('./package.json').version,
});

app.use('/api/auth', authRoutes);
app.use('/api/vod', vodRoutes);
app.use('/api/downloads', downloadsRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/epg', epgRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/logos', logosRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/profiles', profilesRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/m3u', m3uRoutes);
app.use('/api/xspf', xspfRoutes);
app.use('/api/xmltv', xmltvRoutes);
app.use('/api/logs', logsRoutes);
app.use('/stremio', stremioRoutes);
// /proxy must be registered before the SPA static fallback
app.use('/proxy', proxyRoutes);
// Xtream Codes API (/player_api.php, /live/…, /movie/…, /series/…) — after
// /api and /proxy so its catch-all /<user>/<pass>/<id> path never shadows them.
app.use(xtreamRoutes);

// ── Serve frontend (built React app) ──────────────────────────────────────
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    setHeaders: (res, filepath) => {
      if (path.basename(filepath) === 'index.html') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  // SPA fallback — serve index.html for all non-API routes.
  // A request for a hashed asset (e.g. a stale chunk after a redeploy) must NOT
  // fall through to index.html: returning 200 + HTML makes the browser try to
  // evaluate HTML as a JS module ("Failed to fetch dynamically imported module").
  // Return a real 404 so it surfaces as a ChunkLoadError and the client can recover.
  // A RegExp path sidesteps path-to-regexp string parsing, since newer
  // versions reject the bare unnamed '*' wildcard.
  app.get(/.*/, (req, res) => {
    if (/\.\w+$/.test(req.path)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(404).type('text/plain').send('Not found');
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
} else {
  // Development: show API info when frontend not built
  app.get('/', (_req, res) => {
    res.json({
      message: 'stalkerweb API is running. Build the frontend with: cd frontend && npm run build',
      endpoints: [
        'GET  /api/health',
        'POST /api/auth/connect',
        'GET  /api/auth/status',
        'DELETE /api/auth/disconnect',
        'GET  /api/channels',
        'GET  /api/channels/groups/all',
        'GET  /api/epg',
        'GET  /api/epg/:channelId',
        'GET  /api/stream/:channelId',
      ],
    });
  });
}

// ── Global error handler ───────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  log.error('server', `unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Auto-reconnect from saved config on startup ────────────────────────────
// Calls connectPortal() directly — no mock-request hack needed.
async function tryAutoConnect() {
  const CacheManager = require('./cache/CacheManager');
  const cache = new CacheManager(config.dataDir);
  const saved = cache.load();

  if (!saved?.portal || !saved?.mac) {
    log.info('server', 'no saved portal config — waiting for POST /api/auth/connect');
    return;
  }

  log.info('server', `auto-connecting to ${saved.portal} (${saved.mac})`);
  try {
    await connectPortal(saved);
    log.info('server', 'auto-connect: session established ✓');
    appState.touchActivity();
  } catch (e) {
    log.error('server', `auto-connect failed: ${e.message}`);
  }
}

// ── Start server ───────────────────────────────────────────────────────────
const httpServer = app.listen(config.port, () => {
  log.info('server', `stalkerweb running on http://0.0.0.0:${config.port}`);
  log.info('server', `dataDir: ${config.dataDir}`);
  tryAutoConnect();
});

// Optional HTTPS, alongside HTTP. Stremio only installs addons over HTTPS
// (except from 127.0.0.1), so this lets a TV or phone use the Stremio addon
// without a reverse proxy. Set HTTPS_PORT, HTTPS_CERT and HTTPS_KEY (PEM files).
// Problems here are logged and HTTP keeps serving — HTTPS is an add-on.
// Renewed certificates (Let's Encrypt, Tailscale: every ~90 days) are picked
// up without a restart: the files are checked every minute and reloaded when
// they change.
let httpsServer = null;
if (config.httpsPort) {
  const readTls = () => ({ cert: fs.readFileSync(config.httpsCert), key: fs.readFileSync(config.httpsKey) });
  try {
    httpsServer = require('https').createServer(readTls(), app);
    httpsServer.on('error', (e) => {
      log.error('server', `HTTPS listener on port ${config.httpsPort} failed (${e.code || e.message}) — HTTP is still up on ${config.port}`);
    });
    httpsServer.listen(config.httpsPort, () => {
      log.info('server', `stalkerweb also on https://0.0.0.0:${config.httpsPort}`);
    });
    const reload = (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      try {
        httpsServer.setSecureContext(readTls());
        log.info('server', 'HTTPS certificate reloaded');
      } catch (e) {
        log.warn('server', `HTTPS certificate changed but could not be reloaded (keeping the old one): ${e.message}`);
      }
    };
    for (const file of new Set([config.httpsCert, config.httpsKey])) {
      fs.watchFile(file, { interval: 60_000 }, reload).unref?.();
    }
  } catch (e) {
    httpsServer = null;
    log.error('server', `HTTPS not started — check HTTPS_CERT and HTTPS_KEY: ${e.message}`);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  log.info('server', `${signal} received — shutting down`);
  xtreamIdStore.flush();   // Xtream episode ids handed out in the last second
  if (appState.sessionManager) {
    log.info('server', 'destroying portal session…');
    appState.sessionManager.destroy();
  }
  httpsServer?.close();
  httpServer.close(() => {
    log.info('server', 'HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => { log.error('server', 'forced exit after timeout'); process.exit(1); }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
