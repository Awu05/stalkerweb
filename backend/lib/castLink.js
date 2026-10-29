'use strict';

// Links for cast devices (Chromecast, Apple TV). The device fetches the stream
// itself, without the browser's sign-in, so a link carries the playback-only
// share token (/k/<token>, lib/access.js) — never the access key — and the
// address the app was opened on, which the device must be able to reach too.
// In Solo the app is on 127.0.0.1, so links go to the cast listener on the
// device's Wi-Fi address instead, each under a cast token of its own that
// opens only that stream (lib/soloCast.js) — asking for one starts it.

const { origin } = require('./publicUrl');
const soloCast = require('./soloCast');

/** Scheme, host and (with an access key) the share-token prefix. */
function castBase(req, shareToken) {
  return `${origin(req)}${shareToken ? `/k/${shareToken}` : ''}`;
}

/** Whether a host is only this machine — a cast device can't reach that. */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\./.test(h) || h === '0.0.0.0';
}

const VOD_TYPES = { m3u8: 'application/x-mpegURL', mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', ts: 'video/mp2t', mpg: 'video/mp2t', avi: 'video/x-msvideo' };

/** A media type for a movie or episode, from its link's extension (".mp4", ".m3u8"). */
function vodContentType(ext) {
  return VOD_TYPES[String(ext || '').replace(/^\./, '').toLowerCase()] || 'video/mp4';
}

/** What a cast-link request answers: the URL, its type, and whether a device can reach it. */
async function castLink(req, shareToken, pathAndQuery, contentType, live) {
  if (soloCast.active()) {
    // Reachable once the cast listener is up on the Wi-Fi address; without
    // one the link stays on 127.0.0.1 and the app says casting needs Wi-Fi.
    const lan = await soloCast.ensureListener(pathAndQuery);
    return { url: `${lan || castBase(req, shareToken)}${pathAndQuery}`, contentType, live, reachable: !!lan };
  }
  return { url: `${castBase(req, shareToken)}${pathAndQuery}`, contentType, live, reachable: !isLocalHost(req.get('host')) };
}

module.exports = { castBase, isLocalHost, vodContentType, castLink };
