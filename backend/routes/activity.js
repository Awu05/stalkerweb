'use strict';

// GET /api/activity — what's playing now, and on what (Settings → Activity):
// the streams lib/activity.js sees, each with its viewer and title; the
// portal connection; downloads running; channels being cast.

const express = require('express');

module.exports = function activityRoutes(appState, { viewers, downloads } = {}) {
  const router = express.Router();

  const titleOf = (s) => {
    if (s.title) return s.title;
    if (s.kind === 'live') return appState.channelManager?.getChannel?.(s.id)?.name || `Channel ${s.id}`;
    const movieId = s.id.split(':')[0];
    return appState.catalog?.findMovie?.(movieId)?.name || appState.catalog?.findShow?.(movieId)?.name || `Title ${movieId}`;
  };

  // GET /api/activity/delivery?kind=live|vod&id= — how the server sends that
  // stream to the device asking (lib/activity.js deliver()): the player's Stats.
  router.get('/delivery', (req, res) => {
    const { kind, id } = req.query;
    if ((kind !== 'live' && kind !== 'vod') || typeof id !== 'string' || !id) return res.status(400).json({ error: 'kind (live|vod) and id are required' });
    res.json({ delivery: appState.activity?.deliveryFor({ ip: req.ip, ua: req.get('user-agent') || '', kind, id }) ?? null });
  });

  router.get('/', (req, res) => {
    const streams = (appState.activity?.list() ?? []).map((s) => {
      const v = s.viewerId ? viewers?.get(s.viewerId) : null;
      return {
        kind: s.kind, id: s.id, via: s.via,
        title: titleOf(s), subtitle: s.subtitle,
        viewer: v ? { id: v.id, name: v.name, color: v.color } : null,
        device: s.device, ip: s.ip,
        startedAt: s.startedAt, lastSeen: s.lastSeen,
      };
    });
    let portal = null;
    try { portal = new URL(appState.client?.getBasePath?.()).host; } catch { /* not connected */ }
    res.json({
      streams,
      portal: {
        connected: !!appState.sessionManager?.isAuthenticated?.(),
        host: portal,
        openStreams: appState.activeStreams || 0,   // open stream connections through the portal
        casting: appState.castHls?.size ?? 0,         // channels re-wrapped for a TV now
      },
      downloads: (downloads?.list() ?? [])
        .filter((j) => j.status === 'downloading')
        .map((j) => ({
          title: j.seriesTitle ? `${j.seriesTitle} · ${j.title}` : j.title,
          percent: j.totalBytes > 0 ? Math.round((j.bytesDownloaded / j.totalBytes) * 100) : null,
        })),
      now: Date.now(),
    });
  });

  return router;
};
