// routes/settings.js
// GET  /api/settings  — return app-level UI settings
// POST /api/settings  — save app-level UI settings

'use strict';

const express = require('express');
const CacheManager = require('../cache/CacheManager');
const { parseIdleMinutes, MAX_IDLE_MINUTES } = require('../lib/idleTimeout');

const MAX_LIVE_BUFFER_S = 120;
const STB_MODELS    = ['MAG200', 'MAG250', 'MAG254', 'MAG256', 'MAG270', 'MAG322', 'MAG352', 'CUSTOM'];
const STB_FIRMWARES = ['0.2.18-r14-pub-250', '0.2.18-r19-pub-250', 'Generic'];

const DEFAULTS = {
  epg_enabled: true,
  vod_enabled: true,
  show_adult: false,
  disabled_genres: [],
  stbemu_profile_name: '',
  stbemu_stb_model: 'MAG250',
  stbemu_custom_firmware: '',
  stbemu_firmware: '0.2.18-r14-pub-250',
};

module.exports = function settingsModule(config, appState = null, access = null) {
  const router = express.Router();
  const cache = new CacheManager(config.dataDir);

  router.get('/', (_req, res) => {
    const saved = cache.load() || {};
    res.json({
      epg_enabled:             saved.epg_enabled !== undefined ? saved.epg_enabled : DEFAULTS.epg_enabled,
      vod_enabled:             saved.vod_enabled !== undefined ? saved.vod_enabled : DEFAULTS.vod_enabled,
      show_adult:              saved.show_adult !== undefined  ? saved.show_adult  : DEFAULTS.show_adult,
      disabled_genres:         Array.isArray(saved.disabled_genres) ? saved.disabled_genres : DEFAULTS.disabled_genres,
      stbemu_profile_name:     saved.stbemu_profile_name     ?? DEFAULTS.stbemu_profile_name,
      stbemu_stb_model:        saved.stbemu_stb_model        ?? DEFAULTS.stbemu_stb_model,
      stbemu_custom_firmware:  saved.stbemu_custom_firmware  ?? DEFAULTS.stbemu_custom_firmware,
      stbemu_firmware:         saved.stbemu_firmware         ?? DEFAULTS.stbemu_firmware,
      download_dir:            saved.download_dir            || config.downloadDir,
      // Effective value (saved, else IDLE_TIMEOUT_MINUTES). 0 = never.
      idle_timeout_minutes:    appState ? Math.round(appState.idleTimeoutMs / 60000) : null,
      idle_timeout_default:    appState?.idleTimeoutDefaultMinutes ?? null,
      // Built-in HTTPS port (HTTPS_PORT), so the Setup page can offer an
      // https:// Stremio link while the UI itself is open over HTTP.
      https_port:              config.httpsPort || null,
      // Live delay buffer, seconds (0 = off): saved, else LIVE_BUFFER_SECONDS.
      live_buffer_seconds:     saved.live_buffer_seconds ?? config.liveBufferSeconds ?? 0,
      live_buffer_default:     config.liveBufferSeconds ?? 0,
      // With ACCESS_KEY set: the token the Setup page puts in the links it
      // shows (playback only — see lib/access.js). Only full access reads this.
      access_enabled:          !!access?.enabled,
      access_share_token:      access?.shareToken ?? null,
    });
  });

  router.post('/', (req, res) => {
    const existing = cache.load() || {};
    const { epg_enabled, vod_enabled, show_adult, disabled_genres, stbemu_profile_name, stbemu_stb_model, stbemu_custom_firmware, stbemu_firmware, download_dir, idle_timeout_minutes, live_buffer_seconds } = req.body;
    if (epg_enabled !== undefined)            existing.epg_enabled            = !!epg_enabled;
    if (vod_enabled !== undefined)            existing.vod_enabled            = !!vod_enabled;
    if (show_adult !== undefined)             existing.show_adult             = !!show_adult;
    if (disabled_genres !== undefined)        existing.disabled_genres        = Array.isArray(disabled_genres)
                                                ? disabled_genres.filter(s => typeof s === 'string')
                                                : [];
    if (stbemu_profile_name !== undefined)    existing.stbemu_profile_name    = String(stbemu_profile_name).trim();
    if (stbemu_stb_model !== undefined && STB_MODELS.includes(stbemu_stb_model))
                                              existing.stbemu_stb_model       = stbemu_stb_model;
    if (stbemu_custom_firmware !== undefined) existing.stbemu_custom_firmware = String(stbemu_custom_firmware).trim();
    if (stbemu_firmware !== undefined && STB_FIRMWARES.includes(stbemu_firmware))
                                              existing.stbemu_firmware        = stbemu_firmware;
    if (download_dir !== undefined) {
      const dir = String(download_dir).trim();
      if (!dir) return res.status(400).json({ error: 'download_dir cannot be empty' });
      existing.download_dir = dir;
    }
    let idleMinutes = null;
    if (idle_timeout_minutes !== undefined) {
      idleMinutes = parseIdleMinutes(idle_timeout_minutes, null);
      if (idleMinutes === null) {
        return res.status(400).json({ error: `idle_timeout_minutes must be a whole number from 0 (never) to ${MAX_IDLE_MINUTES}` });
      }
      existing.idle_timeout_minutes = idleMinutes;
    }
    if (live_buffer_seconds !== undefined) {
      const n = Number(live_buffer_seconds);
      if (!Number.isInteger(n) || n < 0 || n > MAX_LIVE_BUFFER_S) {
        return res.status(400).json({ error: `live_buffer_seconds must be a whole number from 0 (off) to ${MAX_LIVE_BUFFER_S}` });
      }
      existing.live_buffer_seconds = n;
    }
    cache.save(existing);
    if (idleMinutes !== null) appState?.setIdleTimeoutMinutes(idleMinutes);
    res.json({ success: true, epg_enabled: existing.epg_enabled });
  });

  return router;
};
