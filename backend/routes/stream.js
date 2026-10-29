// routes/stream.js
// GET /api/stream/:channelId  — resolve stream URL for a channel
//
// If the session is not active, auto-reconnects from saved config before
// serving the stream URL (transparent to the caller).

'use strict';

const express = require('express');
const router = express.Router();
const log = require('../logger');
const { castLink } = require('../lib/castLink');
const { reportLine, rateLimiter, isDecodeFailure } = require('../lib/playerReport');
const TAG = 'stream';

module.exports = function streamRoutes(appState) {

  // ── Ensure an authenticated session exists, reconnecting if needed ─────────
  // Shared with the other outside-client entry points (see server.js).
  async function ensureSession() {
    if (appState.ensureSession) return appState.ensureSession();
    if (!appState.sessionManager?.isAuthenticated()) throw new Error('Not connected to a portal. Configure portal first.');
  }

  // GET /api/stream/keepalive — touch activity to prevent idle disconnect
  // Called periodically by the player frontend while a stream is playing.
  router.get('/keepalive', (req, res) => {
    appState.touchActivity?.();
    res.json({ ok: true });
  });

  // A web player's playback error, for the log (lib/playerReport.js).
  const allowReport = rateLimiter();
  router.post('/report', (req, res) => {
    if (!allowReport(req.ip)) return res.status(429).end();
    const line = reportLine(req.body, req.get('user-agent'));
    if (line) log.warn('player', line);
    // The device couldn't decode it: what is the channel's video, exactly?
    const id = String(req.body?.channelId ?? '');
    if (line && /^\d+$/.test(id) && isDecodeFailure(req.body) && appState.describeChannel && allowDescribe(id)) {
      log.info('player', `ch ${id}: reading its format (the device couldn't decode it)…`);
      appState.describeChannel(id)
        .then((d) => log.warn('player', d ? `ch ${id}: ${d}` : `ch ${id}: couldn't read its format`))
        .catch((e) => log.warn('player', `ch ${id}: couldn't read its format — ${e.message}`));
    }
    res.status(204).end();
  });
  // Once per channel per 10 minutes (each probe pulls the channel briefly).
  const described = new Map();
  const allowDescribe = (id) => {
    const t = Date.now();
    if (t - (described.get(id) ?? 0) < 10 * 60_000) return false;
    described.set(id, t);
    if (described.size > 500) described.delete(described.keys().next().value);
    return true;
  };

  // A cast device's link for a live channel: the channel as HLS (CastHls),
  // under the playback-only share token. Nothing is resolved here — the
  // device's first request starts it. ?image=/api/logos/render?… (its logo)
  // comes back as imageUrl, a link the TV can load.
  router.get('/:channelId/cast', async (req, res) => {
    const rawId = req.params.channelId;
    if (!/^\d+$/.test(rawId)) return res.status(400).json({ error: 'Invalid channel ID' });
    // The TV plays it from its own address: claimed for any.
    appState.activity?.claim({ kind: 'live', id: rawId, viewerId: req.viewer?.id, cast: true,
      title: appState.channelManager?.getChannel?.(rawId)?.name });
    appState.castHls?.retry?.(rawId);   // a channel that stopped answering last time gets another go
    res.json(await castLink(req, appState.shareToken, `/proxy/cast/live/${rawId}/index.m3u8`, 'application/x-mpegURL', true,
      typeof req.query.image === 'string' ? req.query.image : null));
  });

  // The sender stopped casting the channel, or moved the TV to another: its
  // cast session lets go of the channel now — it holds the channel's one portal
  // connection, which the phone or page playing it next needs.
  router.delete('/:channelId/cast', (req, res) => {
    appState.castHls?.stop(String(req.params.channelId), 'the sender stopped casting it');
    res.status(204).end();
  });

  // GET /api/stream/:channelId
  // Validates the channel exists (waiting for load if needed) then returns
  // the authenticated proxy URL.  All stream resolution — create_link,
  // matrix, localhost rewriting, HLS playlist rewriting — is handled by
  // /proxy/stream/:channelId which runs server-side with the portal session.

  router.get('/:channelId', async (req, res) => {
    try {
      await ensureSession();
    } catch (e) {
      log.error(TAG, `session check failed: ${e.message}`);
      return res.status(503).json({ error: e.message });
    }

    const { channelManager } = appState;
    const rawId = req.params.channelId;
    if (!/^\d+$/.test(rawId)) {
      log.warn(TAG, `invalid channelId param: "${rawId}"`);
      return res.status(400).json({ error: 'Invalid channel ID' });
    }
    const uniqueId = parseInt(rawId, 10);

    const channel = await channelManager.waitForChannel(uniqueId);
    if (!channel) {
      log.warn(TAG, `channel not found: uniqueId=${uniqueId}`);
      return res.status(404).json({ error: 'Channel not found' });
    }

    appState.touchActivity?.();
    // Settings → Activity: this address plays the channel for this viewer.
    appState.activity?.claim({ ip: req.ip, ua: req.get('user-agent') || '', kind: 'live', id: String(channel.uniqueId ?? uniqueId), viewerId: req.viewer?.id, title: channel.name });

    // Resolve once up-front to tell the player which engine to use (hls.js vs
    // mpegts.js vs native). The result is cached by ChannelManager so the
    // subsequent /proxy/stream fetch reuses this same create_link — one portal
    // link per zap, exactly like a STB. On failure we fall back to 'hls' and let
    // the proxy resolve again (and surface any real error there).
    let streamType = 'hls';
    try {
      const resolved = await channelManager.resolveStream(channel);
      streamType = resolved.type;
      // UDP/RTP/RTSP channels are transcoded server-side by FfmpegService to raw
      // MPEG-TS, so the browser should use mpegts.js — not show an error.
      // If FFmpeg isn't installed we keep 'unsupported' so the UI error still shows.
      if (streamType === 'unsupported') {
        const { isAvailable } = require('../stalker/FfmpegService');
        streamType = isAvailable() ? 'mpegts' : 'unsupported';
      }
    } catch (e) {
      log.warn(TAG, `type pre-resolve failed (proxy will retry): ${e.message}`);
    }

    res.json({
      channelId:   rawId, // string — some clients (Android) type this as String, not a number
      channelName: channel.name,
      streamUrl:   `/proxy/stream/${rawId}`,
      streamType,
    });
  });

  return router;
};
