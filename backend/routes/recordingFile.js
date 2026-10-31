// routes/recordingFile.js — GET /proxy/recording/:id: a finished recording's
// .ts file, for the apps' player (Range requests too, so it can seek).
// Under /proxy like the other streams, so a share-token link plays it.

'use strict';

const express = require('express');
const fs = require('fs');

module.exports = function recordingFileModule(appState) {
  const router = express.Router();
  router.get('/recording/:id', (req, res) => {
    const r = appState.recordingStore?.get(req.params.id);
    if (!r?.filePath || r.status !== 'done' || !fs.existsSync(r.filePath)) return res.status(404).send('No such recording');
    res.type('video/mp2t').sendFile(r.filePath, { acceptRanges: true, dotfiles: 'allow' });
  });
  return router;
};
