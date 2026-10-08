// routes/xspf.js
// GET /api/xspf — the channel list as an XSPF playlist, for VLC.
//
// VLC ignores M3U group-title / #EXTGRP and shows an M3U as one flat list.
// XSPF with VLC's playlist extension (<vlc:node>) is the format VLC renders as
// folders, so this export puts each category in its own collapsible folder.
// Same channels, order and /proxy/stream URLs as /api/m3u.

'use strict';

const express = require('express');
const { groupChannels } = require('./m3u');
const log = require('../logger');
const TAG = 'xspf';

const VLC_EXT = 'http://www.videolan.org/vlc/playlist/0';      // extension application id
const VLC_NS  = 'http://www.videolan.org/vlc/playlist/ns/0/';  // vlc: XML namespace

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Builds the XSPF document. Tracks carry the streams; the trailing VLC
// extension arranges them into one <vlc:node> folder per category by track id.
function buildXspf(channels, groups, base, logoFor = () => '') {
  const tracks = [];
  const folders = new Map(); // category → [track id]

  groupChannels(channels, groups).forEach(({ ch, group }, tid) => {
    const logo = logoFor(ch);
    tracks.push(
      '    <track>',
      `      <location>${xmlEscape(`${base}/proxy/stream/${ch.uniqueId}`)}</location>`,
      `      <title>${xmlEscape(ch.name)}</title>`,
      ...(logo ? [`      <image>${xmlEscape(logo)}</image>`] : []),
      `      <extension application="${VLC_EXT}"><vlc:id>${tid}</vlc:id></extension>`,
      '    </track>'
    );
    if (!folders.has(group)) folders.set(group, []);
    folders.get(group).push(tid);
  });

  const nodes = [];
  for (const [group, ids] of folders) {
    nodes.push(`    <vlc:node title="${xmlEscape(group)}">`);
    for (const id of ids) nodes.push(`      <vlc:item tid="${id}"/>`);
    nodes.push('    </vlc:node>');
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<playlist xmlns="http://xspf.org/ns/0/" xmlns:vlc="${VLC_NS}" version="1">`,
    '  <title>StalkerWeb</title>',
    '  <trackList>',
    ...tracks,
    '  </trackList>',
    `  <extension application="${VLC_EXT}">`,
    ...nodes,
    '  </extension>',
    '</playlist>',
    '',
  ].join('\n');
}

module.exports = function xspfModule(appState, logoManager) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { channelManager } = appState;
    if (!channelManager) {
      return res.status(503).send('Not connected to portal — connect first via the web UI');
    }

    const channels = channelManager.getChannels();
    if (channels.length === 0) {
      return res.status(503).send('No channels loaded yet — try again in a moment');
    }

    // Same logo precedence as the M3U: manual override → portal → iptv-org.
    const logoFor = (ch) => (logoManager ? logoManager.resolveOverride(ch.name) : '')
      || ch.iconPath
      || (logoManager ? logoManager.resolveDbLogo(ch.name) : '')
      || '';

    const base = `${req.protocol}://${req.get('host')}`;
    const xml  = buildXspf(channels, channelManager.getGroups(), base, logoFor);

    log.info(TAG, `serving playlist: ${channels.length} channels`);
    res.set('Content-Type', 'application/xspf+xml; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="stalkerweb.xspf"');
    res.set('Cache-Control', 'no-cache');
    res.send(xml);
  });

  return router;
};

module.exports.buildXspf = buildXspf;
