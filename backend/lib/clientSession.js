'use strict';

// Readiness for requests from outside players — playlists, the guide, the
// Xtream API, the Stremio addon. These arrive without the web UI, often long
// after the idle auto-disconnect, so the portal session is brought back first
// (appState.ensureSession, server.js) instead of answering "not connected".

const log = require('../logger');
const TAG = 'session';

/**
 * Reconnects if needed and, with `waitForChannels`, waits up to `timeoutMs`
 * for a channel list that is still loading. Never throws.
 * @returns {Promise<boolean>} whether a portal session is up
 */
async function readyForClient(appState, { waitForChannels = false, timeoutMs = 60_000 } = {}) {
  if (!appState.channelManager || !appState.sessionManager?.isAuthenticated?.()) {
    try {
      await appState.ensureSession?.();
    } catch (e) {
      log.warn(TAG, `auto-reconnect failed: ${e.message}`);
    }
  }
  const cm = appState.channelManager;
  if (waitForChannels && cm && cm.getChannels().length === 0 && cm.loadChannels) {
    let timer;
    await Promise.race([
      cm.loadChannels().catch(() => {}),
      new Promise((r) => { timer = setTimeout(r, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }
  return !!appState.channelManager;
}

module.exports = { readyForClient };
