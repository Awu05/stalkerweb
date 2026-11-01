// routes/recordingFile.js — a finished recording, for the apps' players:
//   GET /proxy/recording/:id             the .ts file (Range requests too)
//   GET /proxy/recording/:id/index.m3u8  the same file as HLS: its pieces as
//                                         byte ranges (recordings/Recorder.js
//                                         wrote each on a keyframe, with an
//                                         index), so a browser can play and seek it
// Under /proxy like the other streams, so a share-token link plays it.

'use strict';

const express = require('express');
const fs = require('fs');
const { readPieces } = require('../recordings/pieceIndex');

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

module.exports = function recordingFileModule(appState) {
  const router = express.Router();
  const finished = (id) => {
    const r = appState.recordingStore?.get(id);
    return r?.filePath && r.status === 'done' && fs.existsSync(r.filePath) ? r : null;
  };

  router.get('/recording/:id', (req, res) => {
    const r = finished(req.params.id);
    if (!r) return res.status(404).send('No such recording');
    res.type('video/mp2t').sendFile(r.filePath, { acceptRanges: true, dotfiles: 'allow' });
  });

  router.get('/recording/:id/index.m3u8', (req, res) => {
    const r = finished(req.params.id);
    const pieces = r ? piecesOf(r.filePath) : [];
    if (!pieces.length) return res.status(404).send('No such recording');
    // The file sits beside the playlist: "../<id>" from …/<id>/index.m3u8.
    res.type('application/vnd.apple.mpegurl').send(playlistOf(pieces, `../${encodeURIComponent(r.id)}`));
  });

  return router;
};

module.exports.playlistOf = playlistOf;
