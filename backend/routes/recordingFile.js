// routes/recordingFile.js — a finished recording, for the apps' players:
//   GET /proxy/recording/:id             the .ts file (Range requests too)
//   GET /proxy/recording/:id/index.m3u8  the same file as HLS: its pieces as
//                                         byte ranges (recordings/Recorder.js
//                                         wrote each on a keyframe, with an
//                                         index), so a browser can play and seek it
// Under /proxy like the other streams, so a share-token link plays it.
//
// A request that names its viewer (X-Viewer, ?viewer=) gets only a recording
// that viewer may see (recordings/visibility.js: its own, or one whose channel
// its filters show) — 404 otherwise. One naming none (a cast device, a share
// link) plays any. The playlist carries ?viewer= on to the file it points at.

'use strict';

const express = require('express');
const fs = require('fs');
const { readPieces } = require('../recordings/pieceIndex');
const { recordingRules, namesViewer } = require('../recordings/visibility');

/** A recording's pieces from its index file, those inside the file — [] when it has none. */
function piecesOf(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  return readPieces(`${file}.index`, size);
}

/** The VOD playlist of a recording's pieces, each a byte range of `uri`. */
function playlistOf(pieces, uri) {
  // A loop, not Math.max(...): a recording of many hours has more pieces than a call takes arguments.
  let target = 1;
  for (const p of pieces) if (Math.ceil(p.d) > target) target = Math.ceil(p.d);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:4', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (const p of pieces) {
    if (p.disc) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${p.d.toFixed(3)},`, `#EXT-X-BYTERANGE:${p.l}@${p.o}`, uri);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// viewerOf, channels: as routes/recordings.js takes them.
module.exports = function recordingFileModule(appState, { viewerOf = () => null, channels = () => [] } = {}) {
  const router = express.Router();
  const finished = (req) => {
    const r = appState.recordingStore?.get(req.params.id);
    if (!(r?.filePath && r.status === 'done' && fs.existsSync(r.filePath))) return null;
    if (namesViewer(req) && !recordingRules(req.viewer, { viewerOf, channels }).visible(r)) return null;
    return r;
  };

  router.get('/recording/:id', (req, res) => {
    const r = finished(req);
    if (!r) return res.status(404).send('No such recording');
    res.type('video/mp2t').sendFile(r.filePath, { acceptRanges: true, dotfiles: 'allow' });
  });

  router.get('/recording/:id/index.m3u8', (req, res) => {
    const r = finished(req);
    const pieces = r ? piecesOf(r.filePath) : [];
    if (!pieces.length) return res.status(404).send('No such recording');
    // The file sits beside the playlist: "../<id>" from …/<id>/index.m3u8.
    // A player fetches the file without the headers it fetched this with: ?viewer= goes along.
    const viewer = typeof req.query.viewer === 'string' && req.query.viewer ? `?viewer=${encodeURIComponent(req.query.viewer)}` : '';
    res.type('application/vnd.apple.mpegurl').send(playlistOf(pieces, `../${encodeURIComponent(r.id)}${viewer}`));
  });

  return router;
};

module.exports.playlistOf = playlistOf;
