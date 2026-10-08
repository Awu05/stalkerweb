// routes/m3u.js
// GET /api/m3u — generate an M3U8 playlist for Jellyfin (or any IPTV client)
//
// Each channel entry points to /proxy/stream/:uniqueId so stream URLs are
// resolved on-demand through the authenticated HLS proxy rather than being
// baked in as short-lived portal URLs.
//
// Usage in Jellyfin:
//   Dashboard → Live TV → Tuner Devices → Add → M3U Tuner
//   URL: http://<stalkerweb-host>:3000/api/m3u

'use strict';

const express = require('express');
const log = require('../logger');
const { exportFilterFor } = require('../lib/exportFilter');
const TAG = 'm3u';

const OTHER_GROUP = 'Other';

// Quotes would end the attribute early and corrupt the rest of the line.
const attr = (v) => String(v ?? '').replace(/"/g, "'");

// Pairs each channel with its category name and orders the playlist by
// category (in the portal's genre order), then channel number. Written in raw
// channel-number order, categories interleave and players that show the file
// top to bottom present it as one long mixed list.
//
// The category comes from the genre id → group lookup, falling back to the
// name the channel was given at parse time and finally to "Other", so a
// channel is never left with an empty group-title (which most clients lump
// into one unnamed bucket).
// A channel's genre name: the genre id → group lookup, falling back to the
// name the channel was given at parse time. Empty when neither is known.
// Shared with the XMLTV feed, so a channel's M3U group and guide category agree.
function channelGenre(ch, nameById) {
  return nameById.get(String(ch.genreId)) || ch.genre || '';
}

function groupChannels(channels, groups) {
  const nameById = new Map(groups.map((g) => [String(g.id), g.name]));
  const order    = new Map(groups.map((g, i) => [g.name, i]));
  const rank     = (group) => (order.has(group) ? order.get(group) : group === OTHER_GROUP ? Infinity : groups.length);

  return channels
    .map((ch, i) => ({
      ch,
      i,
      group: channelGenre(ch, nameById) || OTHER_GROUP,
    }))
    .sort((a, b) =>
      rank(a.group) - rank(b.group) ||
      a.group.localeCompare(b.group) ||
      (a.ch.number || Infinity) - (b.ch.number || Infinity) ||
      a.i - b.i)
    .map(({ ch, group }) => ({ ch, group }));
}

module.exports = function m3uModule(appState, logoManager) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { channelManager } = appState;

    if (!channelManager) {
      return res.status(503).send('Not connected to portal — connect first via the web UI');
    }

    const channels = channelManager.getChannels();
    const groups   = channelManager.getGroups();

    if (channels.length === 0) {
      return res.status(503).send('No channels loaded yet — try again in a moment');
    }

    // Hidden genres/languages and adult channels are left out (?all=1 keeps them).
    const shown = channels.filter(exportFilterFor(req, appState).keep);

    // ?prefix=1 writes the category into each name ("Sports | ESPN"), for
    // players with no grouping (Jellyfin Live TV): sorted by name, each
    // category's channels then sit together and the category stays visible.
    const prefix = req.query.prefix === '1';

    const base  = `${req.protocol}://${req.get('host')}`;
    const lines = ['#EXTM3U x-tvg-url=""'];

    for (const { ch, group } of groupChannels(shown, groups)) {
      // Precedence: manual override → Stalker portal logo → iptv-org (manual fetch).
      const logo   = (logoManager ? logoManager.resolveOverride(ch.name) : '')
                  || ch.iconPath
                  || (logoManager ? logoManager.resolveDbLogo(ch.name) : '')
                  || '';
      const name   = (prefix ? `${group} | ${ch.name}` : ch.name).replace(/,/g, ' '); // commas break the EXTINF line
      const chno   = ch.number > 0 ? ` tvg-chno="${ch.number}"` : '';

      lines.push(
        `#EXTINF:-1 tvg-id="${ch.uniqueId}"${chno} tvg-name="${attr(name)}" tvg-logo="${attr(logo)}" group-title="${attr(group)}",${name}`,
        // Some players (older VLC, several TV apps) group on #EXTGRP rather
        // than the group-title attribute.
        `#EXTGRP:${group}`,
        `${base}/proxy/stream/${ch.uniqueId}`
      );
    }

    log.info(TAG, `serving playlist: ${shown.length} of ${channels.length} channels`);

    res.set('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="stalkerweb.m3u"');
    res.set('Cache-Control', 'no-cache');
    res.send(lines.join('\n') + '\n');
  });

  return router;
};

module.exports.groupChannels = groupChannels;
module.exports.channelGenre = channelGenre;
