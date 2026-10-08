'use strict';

// The address a client reached this server on — scheme and host, no trailing
// slash — for links handed back to it (stream URLs, playlist entries, image
// URLs). Behind a reverse proxy, req.protocol follows X-Forwarded-Proto
// ('trust proxy' is set in server.js). One place, so every export builds its
// links the same way.
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { baseUrl };
