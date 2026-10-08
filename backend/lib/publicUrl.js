'use strict';

// The address a client reached this server on — scheme and host, no trailing
// slash — for links handed back to it (stream URLs, playlist entries, image
// URLs). Behind a reverse proxy, req.protocol follows X-Forwarded-Proto
// ('trust proxy' is set in server.js). One place, so every export builds its
// links the same way. With an access key, a request that came in on a
// /k/<token> link gets links under the same prefix (lib/access.js), so the
// streams in a playlist open from wherever the playlist did.
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}${req.accessPrefix || ''}`;
}

module.exports = { baseUrl };
