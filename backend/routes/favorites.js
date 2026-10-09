// routes/favorites.js
// GET    /api/favorites                              — enriched favorites list
// POST   /api/favorites/channels                    — { uniqueId } add channel
// DELETE /api/favorites/channels/:id                — remove channel
// POST   /api/favorites/groups                      — { name } create group
// PUT    /api/favorites/groups/:id                  — { name } rename group
// DELETE /api/favorites/groups/:id                  — delete group
// POST   /api/favorites/groups/:id/channels         — { uniqueId } add to group
// DELETE /api/favorites/groups/:id/channels/:chId   — remove from group

'use strict';

const express = require('express');
const sessionMiddleware = require('../middleware/session');
const log = require('../logger');
const TAG = 'favorites';

// Enrich a list of uniqueId strings with channel objects from channelManager.
// Falls back to a bare { uniqueId } stub for ids the channel manager doesn't
// know about yet — e.g. right after connect, while the channel list is still
// loading in the background. Dropping those ids entirely would make a
// favorited channel silently vanish from every favorites-aware view (heart
// icons, the favorites filter) for the rest of the session, since the
// frontend caches this response and never retries on its own.
// The stub always carries `name` (even empty) — some clients (Android/Moshi)
// deserialize Channel with a required, non-nullable `name` field and would
// throw on a bare { uniqueId } object.
function enrichChannels(ids, channelManager) {
  if (!channelManager) return ids.map(id => ({ uniqueId: id, name: '' }));
  // No parseInt: getChannel() stringifies and also accepts legacy ids, and
  // coercing to a number would turn any non-numeric id into NaN.
  return ids.map(id => channelManager.getChannel(id) ?? { uniqueId: id, name: '' });
}

module.exports = function favoritesModule(viewers, appState) {
  const router = express.Router();
  const guard = sessionMiddleware(appState);
  // This request's viewer's favorites (lib/viewerContext.js sets req.viewer).
  const favs = (req) => viewers.favoritesOf(req.viewer.id);

  // uniqueId used to be a hash of name+number and is now the portal's own id,
  // so favorites saved by an older build hold ids the client will never match
  // against the current channel list — every star would read as unset. Rewrite
  // them once the channel list is complete enough to map them.
  //
  // Deferred to here rather than done at load time because ChannelManager has
  // no reference to favorites. Flagged per ChannelManager instance, so a
  // reconnect (which builds a new one) retries; the migration is idempotent.
  // Tracked per viewer, since each has its own list.
  function migrateFavoriteIdsOnce(req) {
    const cm = appState?.channelManager;
    if (!cm) return;
    cm._favoriteIdsMigrated ??= new Set();
    if (cm._favoriteIdsMigrated.has(req.viewer.id)) return;
    // A partial list would leave genuinely-unknown ids untouched, which is
    // right, but don't mark it done until the full list is in.
    if (cm.getProgress?.().loading || cm.getChannels().length === 0) return;
    try {
      favs(req).migrateLegacyIds(id => cm.resolveLegacyId(id));
      cm._favoriteIdsMigrated.add(req.viewer.id);
    } catch (e) {
      log.warn(TAG, `favorite id migration failed: ${e.message}`);
    }
  }

  // GET /api/favorites
  router.get('/', guard, (req, res) => {
    migrateFavoriteIdsOnce(req);
    const raw = favs(req).getRaw();
    const cm  = appState?.channelManager;
    res.json({
      channels: enrichChannels(raw.channels, cm),
      groups: raw.groups.map(g => ({
        ...g,
        channels: enrichChannels(g.channels, cm),
      })),
    });
  });

  // POST /api/favorites/channels  { uniqueId }
  router.post('/channels', (req, res) => {
    const { uniqueId } = req.body;
    if (!uniqueId) return res.status(400).json({ error: 'uniqueId required' });
    favs(req).addChannel(uniqueId);
    res.json({ success: true });
  });

  // DELETE /api/favorites/channels/:id
  router.delete('/channels/:id', (req, res) => {
    favs(req).removeChannel(req.params.id);
    res.json({ success: true });
  });

  // POST /api/favorites/groups  { name }
  router.post('/groups', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const group = favs(req).createGroup(name);
    res.json({ success: true, group });
  });

  // PUT /api/favorites/groups/:id  { name }
  router.put('/groups/:id', (req, res) => {
    const { name } = req.body;
    const g = favs(req).renameGroup(req.params.id, name);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    res.json({ success: true, group: g });
  });

  // DELETE /api/favorites/groups/:id
  router.delete('/groups/:id', (req, res) => {
    favs(req).deleteGroup(req.params.id);
    res.json({ success: true });
  });

  // POST /api/favorites/groups/:id/channels  { uniqueId }
  router.post('/groups/:id/channels', (req, res) => {
    const { uniqueId } = req.body;
    if (!uniqueId) return res.status(400).json({ error: 'uniqueId required' });
    const g = favs(req).addChannelToGroup(req.params.id, uniqueId);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    res.json({ success: true });
  });

  // PUT /api/favorites/channels/order  { order: string[] }
  router.put('/channels/order', (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    favs(req).reorderChannels(order);
    res.json({ success: true });
  });

  // PUT /api/favorites/groups/order  { order: string[] }
  router.put('/groups/order', (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    favs(req).reorderGroups(order);
    res.json({ success: true });
  });

  // DELETE /api/favorites/groups/:id/channels/:chId
  router.delete('/groups/:id/channels/:chId', (req, res) => {
    const g = favs(req).removeChannelFromGroup(req.params.id, req.params.chId);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    res.json({ success: true });
  });

  return router;
};
