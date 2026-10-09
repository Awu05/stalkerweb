// routes/viewers.js
// GET    /api/viewers              — { defaultViewerId, viewers: [{ id, name, color }] }
// POST   /api/viewers              — { name, color? } create
// GET    /api/viewers/me           — the viewer this request is for, with its filters
// PUT    /api/viewers/me/filters   — { disabledGenres?, disabledLanguages?, showAdult? }
// PUT    /api/viewers/:id          — { name?, color? }
// DELETE /api/viewers/:id          — not the last one

'use strict';

const express = require('express');
const log = require('../logger');
const TAG = 'viewers';

const summary = ({ id, name, color }) => ({ id, name, color });

module.exports = function viewersModule(viewers) {
  const router = express.Router();

  const details = (v) => ({
    ...summary(v),
    isDefault: v.id === viewers.getDefault()?.id,
    disabledGenres: v.disabledGenres ?? [],
    disabledLanguages: v.disabledLanguages ?? [],
    showAdult: v.showAdult === true,
  });

  // Runs a change and answers with its result, or with the error it raised.
  function answer(res, fn) {
    try {
      res.json(fn());
    } catch (e) {
      // By name, not instanceof: a second copy of the module (tests) has its own class.
      if (e.name === 'ViewerError') return res.status(e.status).json({ error: e.message });
      log.error(TAG, e.message);
      res.status(500).json({ error: 'The viewers could not be saved.' });
    }
  }

  router.get('/', (_req, res) => answer(res, () => viewers.list()));
  router.post('/', (req, res) => answer(res, () => summary(viewers.create(req.body ?? {}))));
  router.get('/me', (req, res) => answer(res, () => details(viewers.get(req.viewer.id) ?? viewers.getDefault())));
  router.put('/me/filters', (req, res) => answer(res, () => details(viewers.setFilters(req.viewer.id, req.body ?? {}))));
  router.put('/:id', (req, res) => answer(res, () => summary(viewers.update(req.params.id, req.body ?? {}))));
  router.delete('/:id', (req, res) => answer(res, () => { viewers.remove(req.params.id); return { success: true }; }));

  return router;
};
