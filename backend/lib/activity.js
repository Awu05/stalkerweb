'use strict';

// Who's watching what, right now (Settings → Activity).
//
// Streams: every live channel and movie this server hands out goes through
// /proxy — live playlists and segments carry their channel (ch=), movies their
// videoId — so each request "touches" an entry per address + device + what.
// An entry is active while a request for it is open (an MPEG-TS pipe) or
// one came in the last 30 s (HLS: a playlist or segment every few seconds).
//
// Viewers: the stream requests of a browser or the app don't say whose they
// are (a <video> sends no X-Viewer). The API calls that start them do — the
// player resolving a channel, the VOD player saving progress — so those
// "claim" what an address is playing for a viewer, and an entry from that
// address takes it. A link naming its viewer (M3U ?viewer=, Stremio /v/,
// an Xtream username) says so itself. A cast link is claimed by the phone,
// and played from the TV's address: those claims hold for any address.

const { deviceOf } = require('./device');

const STALE_MS = 30_000;            // an entry with nothing open, and no request this long, is over
const CLAIM_MS = 6 * 60 * 60_000;   // which viewer started something, kept this long

class ActivityTracker {
  constructor({ now = Date.now, staleMs = STALE_MS } = {}) {
    this._now = now;
    this._stale = staleMs;
    this._streams = new Map();   // ip|ua|kind|id → entry
    this._claims = new Map();    // ip|kind|id (ip '*' for a cast link) → { viewerId, title, subtitle, at }
  }

  /** A viewer opened `kind`/`id` from `ip` (or, cast: true, sent it to a TV). */
  claim({ ip, kind, id, viewerId, title = '', subtitle = '', cast = false }) {
    if (!id || !kind) return;
    const key = `${cast ? '*' : ip}|${kind}|${id}`;
    const prev = this._claims.get(key);
    this._claims.set(key, {
      viewerId: viewerId || prev?.viewerId || null,
      title: title || prev?.title || '',
      subtitle: subtitle || prev?.subtitle || '',
      at: this._now(),
    });
    if (this._claims.size > 2000) this._claims.delete(this._claims.keys().next().value);
  }

  /**
   * A stream request: { ip, ua, kind: 'live' | 'vod', id, viewerId?, via? }.
   * Returns done() — call it when the response closes.
   */
  touch({ ip, ua = '', kind, id, viewerId = null, via = 'app' }) {
    if (!id || !kind) return () => {};
    const t = this._now();
    const key = `${ip}|${ua}|${kind}|${id}`;
    let e = this._streams.get(key);
    if (!e) {
      // The same device on to another channel: the last one is over.
      if (kind === 'live') {
        for (const [k, o] of this._streams) if (o.kind === 'live' && o.ip === ip && o.ua === ua && o.open === 0) this._streams.delete(k);
      }
      e = { ip, ua, kind, id: String(id), via, viewerId, startedAt: t, lastSeen: t, open: 0 };
      this._streams.set(key, e);
    }
    e.lastSeen = t;
    if (viewerId) e.viewerId = viewerId;
    e.open++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.open = Math.max(0, e.open - 1);
      e.lastSeen = this._now();
    };
  }

  /** What's playing now, newest first: { kind, id, viewerId, title, subtitle, device, ip, via, startedAt, lastSeen }. */
  list() {
    const t = this._now();
    for (const [k, e] of this._streams) if (e.open === 0 && t - e.lastSeen > this._stale) this._streams.delete(k);
    for (const [k, c] of this._claims) if (t - c.at > CLAIM_MS) this._claims.delete(k);
    return [...this._streams.values()]
      .map((e) => {
        const c = this._claims.get(`${e.ip}|${e.kind}|${e.id}`) ?? (e.via === 'cast' ? this._claims.get(`*|${e.kind}|${e.id}`) : null);
        return {
          kind: e.kind, id: e.id, via: e.via,
          viewerId: e.viewerId || c?.viewerId || null,
          title: c?.title || '', subtitle: c?.subtitle || '',
          device: deviceOf(e.ua), ip: e.ip,
          startedAt: e.startedAt, lastSeen: e.lastSeen,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}

/**
 * What a /proxy request plays: { kind, id, via } or null. Live: /stream/<id>,
 * /hls…?ch=<id>, /cast/live/<id>/…; a movie or episode: /vod/stream…?videoId
 * (an episode keyed show:season:episode, as Continue Watching keys it).
 */
function streamOf(path, query = {}) {
  let m = /^\/stream\/([^/?#]+)/.exec(path);
  if (m) return { kind: 'live', id: decodeURIComponent(m[1]), via: 'app' };
  m = /^\/cast\/live\/(\d+)\//.exec(path);
  if (m) return { kind: 'live', id: m[1], via: 'cast' };
  if (/^\/hls(\/|$)/.test(path) && query.ch) return { kind: 'live', id: String(query.ch), via: 'app' };
  if (/^\/vod\/stream/.test(path) && query.videoId) {
    const id = query.seasonId && query.episodeId ? `${query.videoId}:${query.seasonId}:${query.episodeId}` : String(query.videoId);
    return { kind: 'vod', id, via: 'app' };
  }
  return null;
}

module.exports = { ActivityTracker, streamOf, STALE_MS };
