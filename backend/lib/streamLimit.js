'use strict';

// How many of the provider's streams are in use right now — what the stream
// limit (Settings: max_streams) is held against when a recording starts.
//
// The live channels played or cast in the last 30 s (lib/activity.js: an HLS
// player has no stream open between its playlist and segment fetches, so the
// open connections alone miss it) together with the channels being recorded,
// each channel once — and never fewer than the portal streams open now
// (appState.activeStreams).

/** The number of streams in use now. */
function inUse(appState) {
  const channels = new Set();
  for (const e of appState.activity?.list() ?? []) if (e.kind === 'live') channels.add(String(e.id));
  for (const id of appState.recordings?.activeChannels?.() ?? []) channels.add(String(id));
  return Math.max(channels.size, appState.activeStreams || 0);
}

module.exports = { inUse };
