'use strict';

// Who may see, play and delete a recording — decided here, by the server, so
// the apps show Delete from the list's `canDelete` and nothing else (Solo has
// no viewer id on the device: the server's Default viewer owns its recordings).
//
//   • mine      — booked by the request's viewer
//   • orphaned  — its viewer no longer exists (deleted, or the placeholder used
//                 while viewers.json couldn't be read): anyone may delete it
//   • admin     — the request's viewer is the admin (named on the request —
//                 not the default given to one naming none; viewers/ViewersManager.js):
//                 it may delete anyone's
//   • visible   — mine, or its channel passes the viewer's own channel filters
//                 (Show Adult, hidden genres and languages — the same check the
//                 channel list and the exports use, lib/exportFilter.js)

const { buildExportFilter } = require('../lib/exportFilter');

const DELETED_VIEWER = '(deleted viewer)';

/**
 * The rules for one request's viewer. `viewerOf(id)` → the viewer or null;
 * `channels()` → the channel list (for a recording's genre — one whose channel
 * is no longer listed is judged by its name alone); `isAdmin(viewer)` → whether
 * it's the admin.
 */
function recordingRules(viewer, { viewerOf = () => null, channels = () => [], isAdmin = () => false } = {}) {
  const me = viewer?.id ?? null;
  const keep = buildExportFilter({ profile: viewer, showAdult: viewer?.showAdult === true }).keep;
  let byId = null;
  const channelOf = (r) => {
    if (!byId) {
      byId = new Map();
      for (const c of channels() ?? []) byId.set(String(c.id), c);
    }
    return byId.get(String(r.channelId)) ?? { name: r.channelName };
  };
  const mine = (r) => !!r && (r.viewerId ?? null) === me;
  const orphaned = (r) => !!r && !(r.viewerId && viewerOf(r.viewerId));
  const admin = !!viewer && isAdmin(viewer);
  return {
    mine,
    orphaned,
    canDelete: (r) => !!r && (admin || mine(r) || orphaned(r)),
    visible: (r) => mine(r) || keep(channelOf(r)),
    ownerName: (r) => (orphaned(r) ? DELETED_VIEWER : viewerOf(r.viewerId)?.name ?? ''),
  };
}

/** Whether a request names its viewer (X-Viewer, ?viewer=, /v/<id>/) — a cast device or share link names none. */
function namesViewer(req) {
  return !!(req.get('x-viewer') || (typeof req.query?.viewer === 'string' && req.query.viewer) || req.viewerFromPath);
}

module.exports = { recordingRules, namesViewer, DELETED_VIEWER };
