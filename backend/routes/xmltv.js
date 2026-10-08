// routes/xmltv.js
// GET /api/xmltv — generate an XMLTV guide feed for Jellyfin
//
// Uses real EPG data from GuideManager when available, falling back to
// synthetic 1-hour programme blocks for channels with no EPG data.
//
// Query params:
//   ?period=24     — hours of EPG to fetch (default 24, max 168 / 7 days)
//   ?filler=none   — omit filler programmes for channels without EPG data
//   ?categories=none — omit the standard Movie/Sports/Kids/News categories
//
// Jellyfin usage:
//   Dashboard → Live TV → Guide Providers → Add → XMLTV
//   URL: http://<stalkerweb-host>:3000/api/xmltv
//
// The tvg-id in the M3U must match the channel id= in XMLTV for Jellyfin
// to link them. Both use channel.uniqueId.

'use strict';

const express = require('express');
const zlib = require('zlib');
const { promisify } = require('util');
const log = require('../logger');
const { exportFilterFor } = require('../lib/exportFilter');
const { standardCategories } = require('../lib/guideCategories');
const { isAdult } = require('../lib/exportFilter');
const { channelGenre } = require('./m3u');
const TAG = 'xmltv';
const gzip = promisify(zlib.gzip);

// Filler for channels the portal has no EPG for, so they still appear in the
// client's guide. Coarse on purpose: hourly blocks over 7 days were 168
// programmes per channel — on a large portal ~90% of the feed and the bulk of
// the time Jellyfin spends downloading and parsing it.
const FILLER_HOURS = 6;
const FILLER_DAYS  = 7;

// The built feed is cached until the channel list or EPG data changes (both
// are replaced wholesale on reload, so identity is a reliable change signal),
// and a 1-hour TTL keeps the filler window moving forward.
const CACHE_TTL_MS = 60 * 60 * 1000;

function xmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Format a Date as XMLTV timestamp: YYYYMMDDHHmmss +0000
function xmltvDate(d) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    ' +0000'
  );
}

// Builds the XMLTV document. Pure: same inputs, same output.
// `categories: false` leaves out the standard Movie/Sports/Kids/News words
// (?categories=none), for users who set Jellyfin's category lists themselves.
function buildGuideXml({ channels, groups, epgData, filler = true, categories = true, now = new Date() }) {
  const groupName = new Map(groups.map(g => [String(g.id), g.name]));

  // Align filler to a FILLER_HOURS boundary in the past, so blocks line up
  // across refreshes instead of shifting every hour.
  const blockMs     = FILLER_HOURS * 60 * 60 * 1000;
  const start       = new Date(Math.floor(now.getTime() / blockMs) * blockMs);
  const totalBlocks = filler ? (FILLER_DAYS * 24) / FILLER_HOURS : 0;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="stalkerweb" generator-info-url="">',
  ];

  // ── Channel definitions ───────────────────────────────────────────────
  for (const ch of channels) {
    const id   = String(ch.uniqueId);
    const name = xmlEscape(ch.name);
    const logo = xmlEscape(ch.iconPath || '');
    lines.push(`  <channel id="${id}">`);
    lines.push(`    <display-name>${name}</display-name>`);
    if (logo) lines.push(`    <icon src="${logo}" />`);
    lines.push('  </channel>');
  }

  // ── Programme blocks ──────────────────────────────────────────────────
  let realEpgCount = 0;
  let syntheticCount = 0;

  // <category> lines for a real programme: the channel's genre name and the
  // portal's own category for the programme, then the standard words Jellyfin
  // sorts its Movies / Sports / Kids / News rows by. Those come from the
  // portal's programme category when it sends one — it knows the programme —
  // and only otherwise from the channel's genre. Adult channels get none, so
  // nothing of theirs can land in a row like Kids.
  // Memoized per genre + category: both repeat across thousands of programmes.
  const memo = new Map();
  const categoryLines = (genre, progCategory, adult) => {
    const memoKey = `${adult ? 1 : 0}\u0000${genre}\u0000${progCategory ?? ''}`;
    let out = memo.get(memoKey);
    if (out) return out;
    const standard = categories && !adult ? standardCategories(progCategory || genre) : [];
    const seen = new Set();
    out = [];
    for (const c of [genre, progCategory, ...standard]) {
      const key = String(c || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(`    <category lang="en">${xmlEscape(c)}</category>`);
    }
    memo.set(memoKey, out);
    return out;
  };

  for (const ch of channels) {
    const id       = String(ch.uniqueId);
    const name     = xmlEscape(ch.name);
    const genre    = channelGenre(ch, groupName);
    const adult    = isAdult(genre) || isAdult(ch.name);
    // Filler blocks carry only the genre name: they are placeholders named
    // after the channel, and a standard word would show them in Jellyfin's
    // Movies / Sports / … rows as if they were real programmes.
    const fillerCategories = genre ? [`    <category lang="en">${xmlEscape(genre)}</category>`] : [];

    // Try real EPG first: keyed by channelId (portal numeric ID)
    const epgEvents = epgData
      ? (epgData[String(ch.channelId)] ?? epgData[String(ch.uniqueId)] ?? null)
      : null;

    if (epgEvents && Array.isArray(epgEvents) && epgEvents.length > 0) {
      realEpgCount++;
      for (const ev of epgEvents) {
        const evStart = new Date((ev.start_timestamp ?? ev.startTime) * 1000);
        const evStop  = new Date((ev.stop_timestamp  ?? ev.endTime)   * 1000);
        const title   = xmlEscape(ev.name || ev.title || name);
        const descr   = xmlEscape(ev.descr || ev.description || '');
        lines.push(
          `  <programme start="${xmltvDate(evStart)}" stop="${xmltvDate(evStop)}" channel="${id}">`
        );
        lines.push(`    <title lang="en">${title}</title>`);
        if (descr) lines.push(`    <desc lang="en">${descr}</desc>`);
        lines.push(...categoryLines(genre, ev.category ? String(ev.category) : null, adult));
        lines.push('  </programme>');
      }
    } else {
      // Synthetic fallback: coarse blocks for the full window (none with ?filler=none)
      if (filler) syntheticCount++;
      for (let i = 0; i < totalBlocks; i++) {
        const blockStart = new Date(start.getTime() + i * blockMs);
        const blockStop  = new Date(blockStart.getTime() + blockMs);
        lines.push(
          `  <programme start="${xmltvDate(blockStart)}" stop="${xmltvDate(blockStop)}" channel="${id}">`
        );
        lines.push(`    <title lang="en">${name}</title>`);
        lines.push(...fillerCategories);
        lines.push('  </programme>');
      }
    }
  }

  lines.push('</tv>');
  return { xml: lines.join('\n') + '\n', realEpgCount, syntheticCount };
}

module.exports = function xmltvModule(appState) {
  const router = express.Router();
  let cache = null; // { channels, channelCount, filterKey, groups, epgData, period, filler, categories, builtAt, raw, gzipped }

  router.get('/', async (req, res) => {
    const { channelManager, guideManager } = appState;

    if (!channelManager) {
      return res.status(503).send('Not connected to portal');
    }

    const channels = channelManager.getChannels();
    const groups   = channelManager.getGroups();

    if (channels.length === 0) {
      return res.status(503).send('No channels loaded yet');
    }

    // ?period= clamps to [1, 168] hours (max 7 days)
    const period = Math.min(Math.max(parseInt(req.query.period, 10) || 24, 1), 168);

    // Attempt to load real EPG; on failure epgData stays null and we use synthetic blocks.
    let epgData = null;
    if (guideManager) {
      try {
        epgData = await guideManager.loadGuide(period);
        log.info(TAG, `loaded real EPG for ${Object.keys(epgData || {}).length} channels`);
      } catch (e) {
        log.warn(TAG, `EPG load failed, falling back to synthetic: ${e.message}`);
      }
    }

    const filler = req.query.filler !== 'none';
    const categories = req.query.categories !== 'none';
    // Same channels as the M3U: hidden genres/languages and adult channels are
    // left out (?all=1 keeps them). The cache keys on the source list plus the
    // filter's key, since the filtered array is new on every request.
    const filter = exportFilterFor(req, appState);
    // channels.length too: the array is filled in place while a load runs.
    const fresh  = cache && cache.channels === channels && cache.channelCount === channels.length &&
                   cache.filterKey === filter.key && cache.groups === groups &&
                   cache.epgData === epgData && cache.period === period && cache.filler === filler && cache.categories === categories &&
                   Date.now() - cache.builtAt < CACHE_TTL_MS;
    if (!fresh) {
      const t0 = Date.now();
      const shown = channels.filter(filter.keep);
      const { xml, realEpgCount, syntheticCount } = buildGuideXml({ channels: shown, groups, epgData, filler, categories });
      const raw = Buffer.from(xml, 'utf8');
      cache = { channels, channelCount: channels.length, filterKey: filter.key, groups, epgData, period, filler, categories, builtAt: Date.now(), raw, gzipped: await gzip(raw) };
      log.info(TAG, `built guide: ${shown.length} of ${channels.length} channels (${realEpgCount} real EPG, ${syntheticCount} filler) — ` +
        `${(raw.length / 1e6).toFixed(1)}MB, ${(cache.gzipped.length / 1e6).toFixed(1)}MB gzipped, ${Date.now() - t0}ms`);
    } else {
      log.debug(TAG, 'serving cached guide');
    }

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Vary', 'Accept-Encoding');
    if (/\bgzip\b/i.test(req.get('Accept-Encoding') || '')) {
      res.set('Content-Encoding', 'gzip');
      return res.send(cache.gzipped);
    }
    res.send(cache.raw);
  });

  return router;
};

module.exports.buildGuideXml = buildGuideXml;
