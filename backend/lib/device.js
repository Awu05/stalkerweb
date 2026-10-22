'use strict';

// What's on the other end of a stream request, from its User-Agent — for
// Settings → Activity: a TV, an IPTV app, a browser.

const { browserOf } = require('./playerReport');

const APPS = [
  [/CrKey/i, 'Chromecast'],
  [/Apple ?TV|tvOS/i, 'Apple TV'],
  [/TiviMate/i, 'TiviMate'],
  [/IPTV ?Smarters|Smarters/i, 'IPTV Smarters'],
  [/Kodi/i, 'Kodi'],
  [/VLC|LibVLC/i, 'VLC'],
  [/Jellyfin/i, 'Jellyfin'],
  [/Emby/i, 'Emby'],
  [/Plex/i, 'Plex'],
  [/Stremio/i, 'Stremio'],
  [/Dispatcharr/i, 'Dispatcharr'],
  [/ExoPlayerLib|androidx\.media3|okhttp/i, 'Android app'],
  [/Lavf\//i, 'FFmpeg-based player'],   // Jellyfin, Dispatcharr and others pull streams through FFmpeg
];

/** "Chromecast", "TiviMate", "Android app", "iPhone · Safari (iOS 18.1)"… */
function deviceOf(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  for (const [re, name] of APPS) if (re.test(s)) return name;
  // Apple's own player (AirPlay, or Safari playing a stream itself) names its device.
  if (/AppleCoreMedia/i.test(s)) {
    return /iPhone/.test(s) ? 'iPhone (Apple player)' : /iPad/.test(s) ? 'iPad (Apple player)' : /Macintosh/.test(s) ? 'Mac (Apple player)' : 'Apple device';
  }
  return browserOf(s);
}

module.exports = { deviceOf };
