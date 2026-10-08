// routes/proxy.js
// GET /proxy/stream/:channelId    — resolve Stalker stream URL, proxy master m3u8
// GET /proxy/hls?url=<encoded>    — proxy HLS sub-playlists (playlist URLs)
// GET /proxy/hls/seg/:encoded.ts  — proxy HLS segments (.ts extension satisfies
//                                   FFmpeg's allowed_segment_extensions whitelist)
//
// FFmpeg's HLS demuxer rejects segment URLs that don't end in a known extension
// (.ts, .aac, .m4s, etc.). Sub-playlist URLs are not subject to this check.
// So rewriteM3u8() uses two different proxy URL formats:
//   sub-playlists → /proxy/hls?url=<encoded>          (query-string, no ext)
//   segments      → /proxy/hls/seg/<encoded>.ts        (path + .ts ext)

'use strict';

const express = require('express');
const axios = require('axios');
const http  = require('http');
const https = require('https');
const crypto = require('crypto');
const log = require('../logger');
const { baseUrl } = require('../lib/publicUrl');
const { channelIdRules, hlsUrlRules } = require('../middleware/validate');
const { readyForClient } = require('../lib/clientSession');
const TAG = 'proxy';

// Dedicated HTTP clients for CDN stream/segment fetches with a PERSISTENT
// keep-alive connection. Captured STBemu traffic shows it serves a whole movie
// (master playlist → media playlist → every segment) over a SINGLE TCP
// connection; these VOD CDNs allow one connection per token and hang any extra
// one. The portal's cookie-jar client (axios-cookiejar-support) creates a fresh
// agent — i.e. a new connection — per request, so the master succeeded but the
// very next fetch opened a second connection that the CDN stalled until timeout.
// maxSockets:1 funnels each stream's fetches through one reused socket, like a STB.
// No cookie jar: stream CDNs are IP hosts and authenticate via the URL token, so
// the jar never sent cookies to them anyway.
//
// One agent PER STREAM (keyed by CDN origin + playlist directory) rather than a
// single global agent: the "one socket per token" rule is per-stream, so a global
// maxSockets:1 would force every concurrent viewer/stream to contend for the same
// socket and stall. Keying by the directory groups a stream's master/media
// playlists and all its segments onto one socket while isolating distinct streams.
const streamAgentOpts = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1 };
// 5 minutes: long enough to survive a VOD pause without triggering CDN
// "one connection per token" rejections, while still evicting idle entries.
const STREAM_CLIENT_TTL_MS = 300_000;
const streamClients = new Map(); // key → { client, httpAgent, httpsAgent, timer }

// Groups all parts of a single stream (playlist + its segments live under the
// same directory) under one key, while different streams get different keys.
function streamClientKey(url) {
  try {
    const u = new URL(url);
    const dir = u.pathname.replace(/[^/]*$/, ''); // strip the filename
    return `${u.protocol}//${u.host}${dir}`;
  } catch {
    return url;
  }
}

function getStreamClient(url) {
  const key = streamClientKey(url);
  let entry = streamClients.get(key);
  if (!entry) {
    const httpAgent  = new http.Agent(streamAgentOpts);
    const httpsAgent = new https.Agent(streamAgentOpts);
    entry = {
      client: axios.create({ httpAgent, httpsAgent, maxRedirects: 5 }),
      httpAgent,
      httpsAgent,
      timer: null,
    };
    streamClients.set(key, entry);
  }
  // Idle-evict so sockets for finished streams don't accumulate.
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    streamClients.delete(key);
    entry.httpAgent.destroy();
    entry.httpsAgent.destroy();
  }, STREAM_CLIENT_TTL_MS);
  if (entry.timer.unref) entry.timer.unref();
  return entry.client;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function encodeProxyUrl(url) {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeProxyUrl(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function resolveUrl(href, base) {
  if (/^https?:\/\//i.test(href)) return href;
  try { return new URL(href, base).toString(); } catch { return href; }
}

// Returns true if the URL path (before ?) ends with a playlist extension.
function isPlaylistUrl(url) {
  const path = url.split('?')[0].split('#')[0];
  return /\.(m3u8?|m3u)$/i.test(path);
}

// Rewrite every URL in an m3u8 body to route through the proxy.
//
// Sub-playlists  → /proxy/hls?url=<encoded>       (FFmpeg does not apply the
//                                                   segment extension check here)
// Segments       → /proxy/hls/seg/<encoded>.ts     (passes FFmpeg's whitelist)
// URI="" attrs   → /proxy/hls?url=<encoded>        (keys, maps — not segments)
// `secret` (optional) enables HMAC signing of the emitted proxy URLs. Omitted
// in unit tests; always provided in production via proxyModule's per-process key.
// `channelId` (optional) tags emitted URLs with `ch=<id>` so the /hls and
// /hls/seg routes can attribute a CDN 403/404 (expired token) back to the
// channel — recording health and evicting its stale resolved-stream cache.
function rewriteM3u8(body, playlistUrl, proxyOrigin, secret = null, channelId = null) {
  const sig = (abs) => (secret ? signProxyUrl(abs, secret) : null);
  const ch = (channelId !== null && channelId !== undefined) ? String(channelId) : null;
  return body
    .split('\n')
    .map(line => {
      const trimmed = line.trim();

      if (!trimmed) return line;

      // Tag line — rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, etc.)
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const abs = resolveUrl(uri, playlistUrl);
          const s = sig(abs);
          let u = `${proxyOrigin}/proxy/hls?url=${encodeProxyUrl(abs)}`;
          if (s)  u += `&sig=${s}`;
          if (ch) u += `&ch=${ch}`;
          return `URI="${u}"`;
        });
      }

      // URL line — choose format based on whether it's a playlist or segment
      const abs = resolveUrl(trimmed, playlistUrl);
      const s = sig(abs);
      if (isPlaylistUrl(abs)) {
        let u = `${proxyOrigin}/proxy/hls?url=${encodeProxyUrl(abs)}`;
        if (s)  u += `&sig=${s}`;
        if (ch) u += `&ch=${ch}`;
        return u;
      }
      // .ts stays the path suffix (FFmpeg's extension check); sig/ch ride the query.
      let u = `${proxyOrigin}/proxy/hls/seg/${encodeProxyUrl(abs)}.ts`;
      const qp = [];
      if (s)  qp.push(`sig=${s}`);
      if (ch) qp.push(`ch=${ch}`);
      if (qp.length) u += `?${qp.join('&')}`;
      return u;
    })
    .join('\n');
}

function isM3u8Body(text) {
  return text.includes('#EXTM3U') || text.includes('#EXT-X-');
}

// HMAC-sign the absolute target URL so the /hls* fetch routes only honor URLs
// this server actually emitted — closing the SSRF/forged-URL hole where a caller
// could base64-encode any URL and have the server fetch it. The secret is
// per-process (see proxyModule), so URLs naturally expire on restart.
function signProxyUrl(realUrl, secret) {
  return crypto.createHmac('sha256', secret).update(realUrl).digest('base64url');
}

// ── Shared fetch helper ───────────────────────────────────────────────────────

// Note: the first arg is kept for signature/test compatibility but ignored —
// stream fetches always go through a persistent keep-alive client keyed to the
// stream, never the portal's per-request cookie-jar client.
async function fetchFromPortal(_httpClient, headers, url, timeoutMs = 15_000) {
  return getStreamClient(url).get(url, {
    headers,
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    validateStatus: () => true,
  });
}

// Like fetchFromPortal but returns a readable stream instead of buffering the
// whole body — used for segments so .ts data never lands in the Node heap.
async function fetchStreamFromPortal(headers, url, timeoutMs = 15_000) {
  return getStreamClient(url).get(url, {
    headers,
    responseType: 'stream',
    timeout: timeoutMs,
    validateStatus: () => true,
  });
}

// ── Route factory ─────────────────────────────────────────────────────────────

// Exported for unit tests
module.exports.helpers = { encodeProxyUrl, decodeProxyUrl, rewriteM3u8, isPlaylistUrl, resolveUrl, isM3u8Body, fetchFromPortal, signProxyUrl }

module.exports = function proxyModule(appState) {
  const router = express.Router();

  // Per-process key for signing rewritten proxy URLs. Random so it never needs
  // configuring; URLs are short-lived (live HLS) so expiry-on-restart is fine.
  const proxySecret = crypto.randomBytes(32);

  // Verify a client-supplied (realUrl, sig) pair was emitted by us. Constant-time.
  function verifyProxySig(realUrl, sig) {
    if (!sig) return false;
    const expected = signProxyUrl(realUrl, proxySecret);
    const a = Buffer.from(String(sig));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function requireSession(res) {
    if (!appState.client || !appState.channelManager) {
      res.status(503).send('Not connected to portal');
      return false;
    }
    return true;
  }

  // For the links outside players open directly (M3U, Xtream, Stremio): a
  // session that idled out is brought back first, so playback doesn't depend
  // on someone opening the web UI.
  async function requireSessionReconnecting(res) {
    if (!appState.client || !appState.channelManager) await readyForClient(appState);
    return requireSession(res);
  }

  // Fetch a live stream URL and serve it. If the portal returns an HLS playlist
  // we rewrite its URLs through the proxy; if it returns raw MPEG-TS (or any
  // other binary container) we pipe the bytes straight through — exactly like a
  // STB feeding the stream to its ffmpeg-based player. Sniffing the first bytes,
  // rather than trusting the URL extension, means tokenized/extensionless links
  // are served correctly either way.
  async function serveStream(req, res, realUrl, trusted = false, channelId = null, fallbackUrl = null) {
    const setCors = () => res.set('Access-Control-Allow-Origin', '*');

    if (!trusted && !isAllowedUrl(realUrl, appState.client?.getBasePath())) {
      log.warn(TAG, `blocked SSRF attempt to ${realUrl}`);
      setCors();
      return res.status(403).send('Forbidden');
    }

    const headers = getHeadersForUrl(realUrl);

    let response;
    try {
      response = await fetchStreamFromPortal(headers, realUrl, 30_000);
    } catch (e) {
      if (fallbackUrl && fallbackUrl !== realUrl) {
        log.warn(TAG, `stream fetch failed on create_link URL (${e.message}) — retrying with raw channel cmd`);
        return serveStream(req, res, fallbackUrl, trusted, channelId, null);
      }
      log.error(TAG, `stream fetch failed: ${e.message}`);
      if (channelId) appState.channelManager?.recordStreamError(channelId);
      setCors();
      return res.status(502).send(`Fetch failed: ${e.message}`);
    }

    // Tear down the upstream fetch if the viewer aborts so the per-stream socket frees.
    req.on('close', () => { if (!res.writableEnded) response.data?.destroy(); });

    if (response.status >= 400) {
      response.data?.destroy();
      if (fallbackUrl && fallbackUrl !== realUrl) {
        log.warn(TAG, `create_link URL returned ${response.status} — retrying with raw channel cmd`);
        return serveStream(req, res, fallbackUrl, trusted, channelId, null);
      }
      log.warn(TAG, `portal returned ${response.status} on stream — link may have expired`);
      // Expired token on the master link — drop the cached resolution so a retry re-tokenizes.
      if (channelId) appState.channelManager?.recordStreamError(channelId);
      setCors();
      return res.status(502).send(`Portal returned HTTP ${response.status}`);
    }

    // Sniff the first chunk to distinguish an HLS playlist from a binary container.
    // A small playlist (most live master playlists are < 512 bytes) ends DURING
    // the sniff, so track that: if the stream already ended, firstChunk is the
    // whole body and we must NOT try to read more (the 'end' event is already gone
    // and a second listener would hang forever).
    const SNIFF = 512;
    let firstChunk;
    let ended = false;
    try {
      firstChunk = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const stream = response.data;
        const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); };
        const onData  = (c) => { chunks.push(c); size += c.length; if (size >= SNIFF) { stream.pause(); cleanup(); resolve(Buffer.concat(chunks)); } };
        const onEnd   = () => { ended = true; cleanup(); resolve(Buffer.concat(chunks)); };
        const onError = (e) => { cleanup(); reject(e); };
        stream.on('data', onData).once('end', onEnd).once('error', onError);
      });
    } catch (e) {
      log.error(TAG, `stream read failed: ${e.message}`);
      setCors();
      return res.status(502).send(`Fetch failed: ${e.message}`);
    }

    const head = firstChunk.toString('utf8', 0, 128);
    if (isM3u8Body(head)) {
      // HLS playlist — buffer any remainder (only if the stream hasn't already
      // ended during the sniff) and rewrite its URLs through the proxy.
      let body = firstChunk;
      if (!ended) {
        const rest = [firstChunk];
        response.data.resume();
        try {
          await new Promise((resolve, reject) => {
            response.data.on('data', c => rest.push(c));
            response.data.once('end', resolve);
            response.data.once('error', reject);
          });
        } catch (e) {
          log.error(TAG, `playlist read failed: ${e.message}`);
          setCors();
          return res.status(502).send(`Fetch failed: ${e.message}`);
        }
        body = Buffer.concat(rest);
      }
      const proxyOrigin = baseUrl(req);
      const rewritten = rewriteM3u8(body.toString('utf8'), realUrl, proxyOrigin, proxySecret, channelId);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
      setCors();
      return res.send(rewritten);
    }

    // Raw MPEG-TS / binary container — pipe straight through so it never lands in
    // the Node heap. The player (mpegts.js) demuxes it, mirroring the STB's ffmpeg.
    const ct = response.headers['content-type'] || 'video/MP2T';
    res.status(response.status);
    res.set('Content-Type', ct);
    setCors();
    if (response.headers['content-length']) res.set('Content-Length', response.headers['content-length']);
    if (ended) {
      // Whole (small) body already arrived during the sniff — send and finish.
      res.write(firstChunk);
      return res.end();
    }
    res.write(firstChunk);
    response.data.resume();
    response.data.on('error', err => { log.error(TAG, `stream pipe error: ${err.message}`); res.destroy(); });
    response.data.pipe(res);
  }

  function isAllowedUrl(url, allowedOrigin) {
    if (!allowedOrigin) return true
    try {
      const u = new URL(url)
      const a = new URL(allowedOrigin)
      return u.hostname === a.hostname || u.hostname.endsWith('.' + a.hostname)
    } catch {
      return false
    }
  }

  // Blocks SSRF into private/loopback/link-local networks (including the
  // 169.254.169.254 cloud metadata address) regardless of the "trusted" flag.
  // VodManager's stream resolution has a fallback path that can echo back a
  // caller-supplied `cmd` query param verbatim as the resolved URL — a
  // legitimate portal/CDN stream should never point at one of these ranges,
  // so this check is safe to apply unconditionally without breaking real
  // playback.
  function isPrivateOrLoopbackHost(hostname) {
    const h = (hostname || '').toLowerCase();
    if (!h || h === 'localhost') return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a === 127 || a === 10 || a === 0) return true;          // loopback / 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16.0.0/12
      if (a === 192 && b === 168) return true;                     // 192.168.0.0/16
      if (a === 169 && b === 254) return true;                     // link-local incl. cloud metadata
      return false;
    }
    // IPv6 loopback / link-local / unique-local
    return h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
  }

  function getHeadersForUrl(realUrl) {
    const { client } = appState;
    if (!client) return {};
    return client.streamHeadersFor(realUrl);
  }

  // trusted=true skips the SSRF hostname check — use when realUrl came from
  // the portal's own create_link / stream-resolution API (not user-supplied).
  async function servePlaylist(req, res, realUrl, trusted = false, channelId = null) {
    const { client } = appState;
    const http = client.getHttpClient();
    const headers = getHeadersForUrl(realUrl);

    const setCors = () => res.set('Access-Control-Allow-Origin', '*');

    if (!trusted && !isAllowedUrl(realUrl, appState.client?.getBasePath())) {
      log.warn(TAG, `blocked SSRF attempt to ${realUrl}`);
      setCors();
      return res.status(403).send('Forbidden');
    }

    let response;
    try {
      response = await fetchFromPortal(http, headers, realUrl);
    } catch (e) {
      log.error(TAG, `playlist fetch failed: ${e.message}`);
      if (channelId) appState.channelManager?.recordStreamError(channelId);
      setCors();
      return res.status(502).send(`Fetch failed: ${e.message}`);
    }

    if (response.status === 403 || response.status === 404) {
      log.warn(TAG, `portal returned ${response.status} on playlist — URL may have expired`);
      // Sub-playlist token expired — record + evict so the next zap re-tokenizes.
      if (channelId) appState.channelManager?.recordStreamError(channelId);
      setCors();
      // 410, not 502: players retry 5xx with backoff (hls.js ~30s across its
      // retries), but an expired token never comes back. A 4xx fails fast so
      // the player reconnects through /proxy/stream for a fresh create_link.
      return res.status(410).send(`Portal returned HTTP ${response.status} — stream token expired`);
    }
    if (response.status >= 400) {
      if (channelId) appState.channelManager?.recordStreamError(channelId);
      setCors();
      return res.status(502).send(`Portal returned HTTP ${response.status}`);
    }

    const body = Buffer.from(response.data).toString('utf8');
    const proxyOrigin = baseUrl(req);
    const rewritten = rewriteM3u8(body, realUrl, proxyOrigin, proxySecret, channelId);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache, no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  }

  // ── GET /proxy/vod/stream?videoId=X&cmd=<encoded>&series=0 ───────────────
  // Resolves a VOD stream URL via VodManager (auth + all fallbacks), then
  // either proxies an HLS playlist (rewriting sub-URLs) or pipes a direct
  // video stream with Range-request pass-through for seeking.
  // A RegExp path (rather than the string wildcard '/vod/stream*') sidesteps
  // path-to-regexp entirely, since newer versions reject bare unnamed '*'.
  router.get(/^\/vod\/stream/, async (req, res) => {
    // Fix: use requireSession (not just !client) so channelManager is also checked,
    // and unauthenticated requests are rejected consistently with other proxy routes.
    if (!(await requireSessionReconnecting(res))) return;

    const { vodManager, client } = appState;  // snapshot before any await to avoid race
    if (!vodManager) return res.status(503).send('VOD not available');

    appState.attachStreamHeartbeat?.(req, res);   // keep idle timer alive for the whole pipe

    const { videoId, series = '0', seasonId = '', episodeId = '' } = req.query;
    const cmd = req.query.cmd || '';
    if (!videoId) return res.status(400).send('videoId is required');

    let streamUrl;
    try {
      streamUrl = await vodManager.getStreamUrl(videoId, cmd || null, parseInt(series, 10) || 0, { seasonId, episodeId });
    } catch (e) {
      log.error(TAG, `VOD proxy: stream resolution failed: ${e.message}`);
      return res.status(502).send(`Stream resolution failed: ${e.message}`);
    }

    // Fix: guard against null/undefined return (prevents TypeError on .slice below)
    if (!streamUrl) {
      log.error(TAG, `VOD proxy: videoId=${videoId} — resolution returned empty URL`);
      return res.status(502).send('Could not resolve stream URL');
    }

    log.info(TAG, `VOD proxy: videoId=${videoId} → ${streamUrl.slice(0, 80)}…`);

    // Resolution has a fallback path that can echo back the caller-supplied
    // `cmd` query param verbatim (see VodManager._resolveStreamUrl "Fallback
    // 2") — so, unlike a real create_link response, streamUrl here is not
    // fully trustworthy. Block private/loopback/link-local targets before
    // treating it as "trusted" below, regardless of which branch handles it.
    try {
      const resolvedHost = new URL(streamUrl).hostname;
      if (isPrivateOrLoopbackHost(resolvedHost)) {
        log.warn(TAG, `blocked SSRF attempt via VOD stream resolution: ${streamUrl}`);
        return res.status(403).send('Forbidden');
      }
    } catch {
      return res.status(502).send('Invalid stream URL');
    }

    // HLS playlist URL (extension-based fast path) — servePlaylist handles buffering + rewrite
    // trusted=true: private/loopback hosts already blocked above
    if (isPlaylistUrl(streamUrl)) {
      return servePlaylist(req, res, streamUrl, true);
    }

    // Determine if the URL is served directly by the portal (internal) or by an external CDN.
    // Internal links require the portal's session cookies and STB headers to access,
    // so we must proxy them. External CDN links can be redirected directly.
    const basePath = client.getBasePath();
    const isInternal = streamUrl.startsWith(basePath) || isAllowedUrl(streamUrl, basePath);

    if (isInternal) {
      log.info(TAG, `VOD proxy: internal link detected, proxying stream: ${streamUrl}`);
      const portalHttp    = client.getHttpClient();   // internal links need session cookies → jar client
      const streamHeaders = getHeadersForUrl(streamUrl);
      if (req.headers['range']) streamHeaders['Range'] = req.headers['range'];

      let response;
      try {
        response = await portalHttp.get(streamUrl, {
          headers:        streamHeaders,
          responseType:   'stream',
          timeout:        30_000,
          validateStatus: () => true,
        });
      } catch (e) {
        log.error(TAG, `VOD proxy: fetch failed: ${e.message}`);
        return res.status(502).send(`Fetch failed: ${e.message}`);
      }

      if (response.status >= 400) {
        response.data.destroy();
        log.warn(TAG, `VOD proxy: portal returned ${response.status} for ${streamUrl}`);
        return res.status(502).send(`Portal returned HTTP ${response.status}`);
      }

      // If the viewer navigates away / seeks, tear down the upstream fetch so it
      // doesn't keep draining the (maxSockets:1) stream socket to completion.
      req.on('close', () => { if (!res.writableEnded) response.data.destroy(); });

      // Collect the first 512 bytes synchronously (before any await) to sniff for m3u8
      const SNIFF = 512;
      const firstChunk = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const stream = response.data;
        const done = (buf) => {
          stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError);
          resolve(buf);
        };
        const onData  = (chunk) => { chunks.push(chunk); size += chunk.length; if (size >= SNIFF) { stream.pause(); done(Buffer.concat(chunks)); } };
        const onEnd   = () => done(Buffer.concat(chunks));
        const onError = (e) => reject(e);
        stream.on('data', onData).once('end', onEnd).once('error', onError);
      });

      const head = firstChunk.toString('utf8', 0, 128);

      if (isM3u8Body(head)) {
        // Portal served an HLS playlist — buffer the rest (playlists are tiny text files)
        log.info(TAG, `VOD proxy: videoId=${videoId} → m3u8 body detected, buffering for URL rewrite`);
        const allChunks = [firstChunk];
        response.data.resume();
        await new Promise((resolve, reject) => {
          response.data.on('data', c => allChunks.push(c));
          response.data.on('end', resolve);
          response.data.on('error', reject);
        });
        const proxyOrigin = baseUrl(req);
        const rewritten   = rewriteM3u8(Buffer.concat(allChunks).toString('utf8'), streamUrl, proxyOrigin, proxySecret);
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache, no-store');
        res.set('Access-Control-Allow-Origin', '*');
        return res.send(rewritten);
      }

      // Binary video — pipe directly so large files (MP4, MPEG) never land in Node heap.
      const ct = response.headers['content-type'] || 'video/mpeg';
      log.info(TAG, `VOD proxy: videoId=${videoId} → piping binary ${ct}`);
      res.status(response.status);
      res.set('Content-Type', ct);
      res.set('Access-Control-Allow-Origin', '*');
      if (response.headers['content-range'])  res.set('Content-Range', response.headers['content-range']);
      if (response.headers['content-length']) res.set('Content-Length', response.headers['content-length']);
      res.write(firstChunk);
      response.data.resume();
      response.data.on('error', err => { log.error(TAG, `VOD proxy: pipe error: ${err.message}`); res.destroy(); });
      response.data.pipe(res);
    } else {
      // For non-playlist external binary video URLs, redirect directly to the CDN stream URL.
      log.info(TAG, `VOD proxy: redirecting to external CDN stream URL: ${streamUrl}`);
      return res.redirect(302, streamUrl);
    }
  });

  // FFmpeg pulls the link itself and never reports a rejected token back, so
  // the cached link is dropped when its FFmpeg stream ends — the next play
  // (a reconnect after a failure, or a new viewer) gets a fresh create_link.
  // Not before: while it runs, a second fetch must not replace its token.
  function evictWhenDone(res, target) {
    res.once('close', () => appState.channelManager?.invalidateResolved(target));
  }

  // ── GET /proxy/stream/:channelId ──────────────────────────────────────────
  router.get('/stream/:channelId', channelIdRules, async (req, res) => {
    if (!(await requireSessionReconnecting(res))) return;
    appState.attachStreamHeartbeat?.(req, res);   // covers both finite playlists and single long-lived pipes

    const { channelManager } = appState;
    const uniqueId = req.params.channelId;

    const channel = await channelManager.waitForChannel(uniqueId);
    if (!channel) return res.status(404).send('Channel not found');

    log.info(TAG, `play: ch ${channel.number} "${channel.name}" (id ${uniqueId}) — resolving stream`);

    // Catch-up support: if ?startTime= is provided, modify the cmd to request archive stream
    const target = req.query.startTime
      ? { ...channel, cmd: `${channel.cmd} archive=1 start=${req.query.startTime}` }
      : channel;
    if (req.query.startTime) log.info(TAG, `catch-up request for ch ${channel.number}: startTime=${req.query.startTime}`);

    let resolved;
    try {
      resolved = await channelManager.resolveStream(target);
    } catch (e) {
      log.error(TAG, `stream resolution failed: ${e.message}`);
      channelManager.recordStreamError(uniqueId);
      return res.status(502).send(`Stream resolution failed: ${e.message}`);
    }

    const streamUrl = resolved?.url;
    if (!streamUrl) {
      channelManager.recordStreamError(uniqueId);
      return res.status(502).send('Could not resolve stream URL');
    }
    if (resolved.type === 'unsupported') {
      const ffmpegSvc = require('../stalker/FfmpegService');
      if (!ffmpegSvc.isAvailable()) {
        channelManager.recordStreamError(uniqueId);
        log.warn(TAG, `ch ${channel.number}: unsupported protocol — FFmpeg not available: ${streamUrl}`);
        return res.status(415).send('Unsupported stream protocol (UDP/RTP/RTSP) — FFmpeg not installed in this container');
      }
      // FFmpeg will remux (or re-encode) the source to MPEG-TS piped to the browser.
      // probeCodecs runs first inside transcode() to pick copy vs re-encode.
      log.info(TAG, `ch ${channel.number}: remuxing via FFmpeg → ${streamUrl}`);
      channelManager.recordStreamSuccess(uniqueId);
      evictWhenDone(res, target);
      return ffmpegSvc.transcode(streamUrl, req, res);
    }

    channelManager.recordStreamSuccess(uniqueId);
    // The resolved link is deliberately NOT evicted here. Clients often fetch
    // this URL twice in a row (probe, then open); a fresh create_link for the
    // second fetch would invalidate the token the first one is already
    // playing. ChannelManager reuses the link for a short window and evicts
    // it as soon as the stream server rejects it (403 → recordStreamError).

    // Codec-aware fallback for raw HTTP MPEG-TS. Our browser players use
    // mpegts.js, which only decodes H.264 + AAC/MP3 — so a channel encoded in
    // MPEG-2, HEVC or AC-3 resolves fine but won't play, even though it plays in
    // STBemu/VLC (native ffmpeg). Probe the codecs; if the browser can't decode
    // them directly, route through FFmpeg (copy what's playable, transcode the
    // rest) exactly like the UDP/RTP/RTSP path. HLS is left to hls.js as before.
    if (resolved.type === 'mpegts' && /^https?:\/\//i.test(streamUrl)) {
      const ffmpegSvc = require('../stalker/FfmpegService');
      if (ffmpegSvc.isAvailable()) {
        const headers = getHeadersForUrl(streamUrl);
        const probe = await ffmpegSvc.probeCodecs(streamUrl, headers);
        if (!ffmpegSvc.browserDirectPlayable(probe)) {
          log.info(TAG, `ch ${channel.number}: codecs not browser-playable (video=${probe?.video ?? '?'} audio=${probe?.audio ?? '?'}) — routing through FFmpeg`);
          evictWhenDone(res, target);
          return ffmpegSvc.transcode(streamUrl, req, res, headers);
        }
      }
    }

    // Some portals' create_link response is unreliable (e.g. clobbers the
    // stream id while minting a fresh token) even though the channel's own
    // cmd is already a working, pre-tokenized link. Give serveStream that raw
    // URL to retry against if the create_link one fails.
    const rawUrl = channelManager.getRawStreamUrl(target);
    const fallbackUrl = (rawUrl && /^https?:\/\//i.test(rawUrl) && rawUrl !== streamUrl) ? rawUrl : null;

    log.info(TAG, `stream for ch ${channel.number} (${resolved.type}): ${streamUrl}`);
    return serveStream(req, res, streamUrl, true, uniqueId, fallbackUrl); // trusted — URL from portal create_link
  });

  // ── GET /proxy/hls?url=<encoded> — sub-playlist proxy ────────────────────
  router.get('/hls', hlsUrlRules, async (req, res) => {
    if (!requireSession(res)) return;
    appState.attachStreamHeartbeat?.(req, res);

    const encoded = req.query.url;
    if (!encoded) return res.status(400).send('Missing url parameter');

    let realUrl;
    try {
      realUrl = decodeProxyUrl(encoded);
    } catch {
      return res.status(400).send('Invalid url encoding');
    }

    // Only fetch URLs we ourselves emitted (and signed) — blocks forged-URL SSRF.
    if (!verifyProxySig(realUrl, req.query.sig)) {
      log.warn(TAG, 'rejected unsigned/invalid /hls url');
      return res.status(403).send('Forbidden');
    }

    // trusted=true: the signature proves this URL came from an m3u8 we rewrote.
    // Portals deliver streams via CDNs whose hostnames differ from the portal.
    // ch (if present) lets servePlaylist attribute an expiry back to the channel.
    return servePlaylist(req, res, realUrl, true, req.query.ch || null);
  });

  // ── GET /proxy/hls/seg/:encoded.ts — segment proxy ───────────────────────
  // The .ts suffix is part of the :encoded param value; strip it before decoding.
  // FFmpeg requires a known extension on segment URLs — .ts satisfies the check
  // regardless of the actual container (FFmpeg detects format from content bytes).
  router.get('/hls/seg/:encoded', async (req, res) => {
    if (!requireSession(res)) return;
    appState.attachStreamHeartbeat?.(req, res);

    // Strip the .ts (or any other) extension we appended for FFmpeg compatibility
    let encoded = req.params.encoded.replace(/\.[^.]+$/, '');

    let realUrl;
    try {
      realUrl = decodeProxyUrl(encoded);
    } catch {
      return res.status(400).send('Invalid url encoding');
    }

    // Only fetch URLs we ourselves emitted (and signed) — blocks forged-URL SSRF.
    if (!verifyProxySig(realUrl, req.query.sig)) {
      log.warn(TAG, 'rejected unsigned/invalid segment url');
      return res.status(403).send('Forbidden');
    }

    const headers = getHeadersForUrl(realUrl);
    // STBemu requests media segments with Accept-Encoding: identity (it only
    // uses gzip for the playlists). Match that exactly for .ts/.aac/.m4s fetches.
    headers['Accept-Encoding'] = 'identity';

    let response;
    try {
      response = await fetchStreamFromPortal(headers, realUrl);
    } catch (e) {
      log.error(TAG, `segment fetch failed: ${e.message}`);
      return res.status(502).send(`Fetch failed: ${e.message}`);
    }

    // If the viewer aborts (seek/switch/close), tear down the upstream fetch so
    // it doesn't keep occupying the per-stream (maxSockets:1) socket.
    req.on('close', () => { if (!res.writableEnded) response.data?.destroy(); });

    const ch = req.query.ch || null;
    if (response.status === 403) {
      response.data.destroy();
      log.warn(TAG, 'portal returned 403 on segment — stream token expired');
      // Token expired mid-stream — record + evict so the next play re-tokenizes.
      if (ch) appState.channelManager?.recordStreamError(ch);
      // 410 so the player fails fast instead of retrying a dead token (see servePlaylist).
      return res.status(410).send('Portal returned HTTP 403 — stream token expired');
    }
    if (response.status === 404) {
      // A segment that has dropped out of the live window (the player fell a
      // little behind). The token is fine: answer with a 5xx so the player
      // retries or moves on, and keep the cached link.
      response.data.destroy();
      log.debug(TAG, 'portal returned 404 on segment — segment no longer available');
      return res.status(502).send('Portal returned HTTP 404 — segment no longer available');
    }
    if (response.status >= 400) {
      response.data.destroy();
      if (ch) appState.channelManager?.recordStreamError(ch);
      return res.status(502).send(`Portal returned HTTP ${response.status}`);
    }

    // Sniff the first chunk in case the portal unexpectedly returns a playlist
    // instead of a segment, without buffering the whole (potentially large) body.
    const SNIFF = 64;
    let firstChunk;
    try {
      firstChunk = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const stream = response.data;
        const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); };
        const onData  = (chunk) => { chunks.push(chunk); size += chunk.length; if (size >= SNIFF) { stream.pause(); cleanup(); resolve(Buffer.concat(chunks)); } };
        const onEnd   = () => { cleanup(); resolve(Buffer.concat(chunks)); };
        const onError = (e) => { cleanup(); reject(e); };
        stream.on('data', onData).once('end', onEnd).once('error', onError);
      });
    } catch (e) {
      log.error(TAG, `segment read failed: ${e.message}`);
      return res.status(502).send(`Fetch failed: ${e.message}`);
    }

    const head = firstChunk.toString('utf8', 0, 64);
    if (isM3u8Body(head)) {
      // Rare: portal returned a playlist here. These are tiny — buffer the rest.
      const rest = [firstChunk];
      response.data.resume();
      try {
        await new Promise((resolve, reject) => {
          response.data.on('data', c => rest.push(c));
          response.data.once('end', resolve);
          response.data.once('error', reject);
        });
      } catch (e) {
        log.error(TAG, `segment playlist read failed: ${e.message}`);
        return res.status(502).send(`Fetch failed: ${e.message}`);
      }
      const proxyOrigin = baseUrl(req);
      const rewritten = rewriteM3u8(Buffer.concat(rest).toString('utf8'), realUrl, proxyOrigin, proxySecret, ch);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    // Binary segment — pipe straight through so it never lands in the Node heap.
    const ct = response.headers['content-type'] || 'video/MP2T';
    res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    if (response.headers['content-length']) res.set('Content-Length', response.headers['content-length']);
    res.write(firstChunk);
    response.data.resume();
    response.data.on('error', err => { log.error(TAG, `segment pipe error: ${err.message}`); res.destroy(); });
    response.data.pipe(res);
  });

  return router;
};
