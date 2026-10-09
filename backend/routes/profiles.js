// routes/profiles.js
// GET    /api/profiles           — { profiles, activeProfileId }
// POST   /api/profiles           — create a profile, returns it
// PUT    /api/profiles/:id       — update a profile, returns it
// DELETE /api/profiles/:id       — delete a profile
// PUT    /api/profiles/active    — { id } set the active profile (id may be null)

'use strict';

const express = require('express');

module.exports = function profilesModule(profilesManager) {
  const router = express.Router();

  // Channel filters belong to viewers now (routes/viewers.js), but the Android
  // app still reads them from the portal profile — so report the requesting
  // viewer's (the default one, for a client that names none) in their place.
  router.get('/', (req, res) => {
    const list = profilesManager.list();
    const v = req.viewer;
    if (v) {
      list.profiles = list.profiles.map((p) => ({
        ...p,
        disabledGenres: v.disabledGenres ?? [],
        disabledLanguages: v.disabledLanguages ?? [],
      }));
    }
    res.json(list);
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (!body.portal) return res.status(400).json({ error: 'portal is required' });
    if (!body.mac)    return res.status(400).json({ error: 'mac is required' });
    res.json(profilesManager.create(body));
  });

  router.put('/active', (req, res) => {
    const { id } = req.body || {};
    const ok = profilesManager.setActive(id || null);
    if (!ok) return res.status(404).json({ error: 'profile not found' });
    res.json({ success: true, activeProfileId: id || null });
  });

  router.put('/:id', (req, res) => {
    // The filters GET shows are the viewer's (above); the profile keeps its own
    // pre-viewer ones untouched, so going back to an older version still works.
    const { disabledGenres: _g, disabledLanguages: _l, ...patch } = req.body || {};
    const updated = profilesManager.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'profile not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    const ok = profilesManager.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'profile not found' });
    res.json({ success: true });
  });

  return router;
};
