'use strict';

// Who's watching what, right now (Settings → Activity).
//
// Streams: every live channel and movie this server hands out goes through
// /proxy — live playlists and segments carry their channel (ch=), an HLS
// movie's its key (v=), a movie file its videoId — so each request "touches"
// an entry per address + device + what. An entry is active while a request
// for it is open (an MPEG-TS pipe) or one came in the last 30 s (HLS: a
// playlist or segment every few seconds; a movie: the player's progress
// saves every 10 s, which also cover one the proxy redirected to a CDN).
//
// Viewers: the stream requests of a browser or the app don't say whose they
// are (a <video> sends no X-Viewer). The API calls that start them do — the
// player resolving a channel, the VOD player's stream link and progress
// saves — so those "claim" what an address is playing for a viewer, and an
// entry from that address takes it. A link naming its viewer (M3U ?viewer=,
// Stremio /v/, an Xtream username) says so itself. A cast link is claimed by
// the phone and played from the TV's address: those claims hold for any.

const { deviceOf } = require('./device');

const STALE_MS = 30_000;            // an entry with nothing open, and no request this long, is over
const CLAIM_MS = 6 * 60 * 60_000;   // which viewer started something, kept this long
const MAX_CLAIMS = 2000;
const PRUNE_EVERY_MS = 60_000;

// A TV fetching what it was cast (Chromecast; an Apple TV, AirPlay included).
const CAST_DEVICE = /CrKey|Apple ?TV|tvOS/i;
// An iPhone/Mac page's <video> playing the stream itself, under its own name.
const MEDIA_FETCHER = /AppleCoreMedia/i;

/** A movie's or episode's key, as Continue Watching keys it: "100", "200:s1:e3" (empty parts left out). */
function vodKey({ videoId, seasonId = '', episodeId = '' } = {}) {
  return [videoId, seasonId, episodeId].filter((p) => p !== undefined && p !== null && String(p) !== '').map(String).join(':');
}

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

class ActivityTracker {
  constructor({ now = Date.now, staleMs = STALE_MS } = {}) {
    this._now = now;
    this._stale = staleMs;
    this._streams = new Map();   // ip|ua|kind|id → entry
    this._claims = new Map();    // ip|kind|id (ip '*' for a cast link) → { viewerId, title, subtitle, at }
    this._fetched = new Map();   // ip|kind|id → { delivery, at }: what a page's own player was sent (MEDIA_FETCHER)
    this._prunedAt = now();
  }

  /**
   * A viewer opened `kind`/`id` from `ip` (or, cast: true, sent it to a TV).
   * With `ua` for a live channel: that device has moved on from any other
   * live channel it isn't pulling right now (a zap on the website or the app —
   * an IPTV app's multiview makes no such call, so keeps its channels).
   */
  claim({ ip, ua = null, kind, id, viewerId, title = '', subtitle = '', cast = false }) {
    if (!id || !kind) return;
    const key = `${cast ? '*' : ip}|${kind}|${id}`;
    const prev = this._claims.get(key);
    this._claims.delete(key);   // to the end: the claims refreshed most stay longest
    this._claims.set(key, {
      viewerId: viewerId || prev?.viewerId || null,
      title: title || prev?.title || '',
      subtitle: subtitle || prev?.subtitle || '',
      at: this._now(),
    });
    if (this._claims.size > MAX_CLAIMS) this._claims.delete(this._claims.keys().next().value);
    if (kind === 'live' && !cast && ua !== null) {
      for (const [k, o] of this._streams) {
        if (o.kind === 'live' && o.ip === ip && o.ua === ua && o.id !== String(id) && o.open === 0) this._streams.delete(k);
      }
    }
  }

  /**
   * A stream request: { ip, ua, kind: 'live' | 'vod', id, viewerId?, via? }.
   * Returns done() — call it when the response closes.
   */
  touch({ ip, ua = '', kind, id, viewerId = null, via = 'app' }) {
    if (!id || !kind) return () => {};
    const t = this._now();
    if (t - this._prunedAt > PRUNE_EVERY_MS) this._prune(t);
    if (via === 'app' && CAST_DEVICE.test(ua)) via = 'cast';
    const key = `${ip}|${ua}|${kind}|${id}`;
    let e = this._streams.get(key);
    if (!e) {
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

  /**
   * How the server sends `kind`/`id` to this device — { mode, detail }, mode
   * 'direct' (the provider's own link), 'relayed' (as it comes), 'repackaged'
   * (FFmpeg, codecs copied) or 'converted' (FFmpeg re-encoding). The player's Stats.
   */
  deliver({ ip, ua = '', kind, id }, delivery) {
    const e = this._streams.get(`${ip}|${ua}|${kind}|${id}`);
    if (e) e.delivery = delivery;
    if (MEDIA_FETCHER.test(ua)) {
      // Kept past the fetch: a movie it was redirected for asks nothing more of this server.
      const key = `${ip}|${kind}|${id}`;
      this._fetched.delete(key);
      if (delivery) this._fetched.set(key, { delivery, at: this._now() });
      if (this._fetched.size > MAX_CLAIMS) this._fetched.delete(this._fetched.keys().next().value);
    }
  }

  /**
   * What deliver() said for this device, or null. An iPhone/Mac page asks as
   * the browser while its <video> fetched as AppleCoreMedia: that's its own
   * player's. No other device's — two on one address (a shared connection, a
   * reverse proxy) can be sent the same channel differently.
   */
  deliveryFor({ ip, ua = '', kind, id }) {
    const own = this._streams.get(`${ip}|${ua}|${kind}|${id}`);
    if (own?.delivery) return own.delivery;
    return this._fetched.get(`${ip}|${kind}|${id}`)?.delivery ?? null;
  }

  _prune(t) {
    this._prunedAt = t;
    for (const [k, e] of this._streams) if (e.open === 0 && t - e.lastSeen > this._stale) this._streams.delete(k);
    for (const [k, c] of this._claims) if (t - c.at > CLAIM_MS) this._claims.delete(k);
    for (const [k, f] of this._fetched) if (t - f.at > CLAIM_MS) this._fetched.delete(k);
  }

  /** What's playing now, newest first: { kind, id, viewerId, title, subtitle, device, ip, via, startedAt, lastSeen }. */
  list() {
    this._prune(this._now());
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

  get size() { return this._streams.size; }
}

/**
 * What a /proxy request plays: { kind, id, via } or null. Live: /stream/<id>,
 * /hls…?ch=<id>, /cast/live/<id>/…; a movie or episode: /vod/stream…?videoId,
 * or /hls…?v=<key> (an HLS movie's playlists and segments).
 */
function streamOf(path, query = {}) {
  let m = /^\/stream\/([^/?#]+)/.exec(path);
  if (m) return { kind: 'live', id: decode(m[1]), via: 'app' };
  m = /^\/cast\/live\/(\d+)\//.exec(path);
  if (m) return { kind: 'live', id: m[1], via: 'cast' };
  if (/^\/hls(\/|$)/.test(path)) {
    if (query.ch) return { kind: 'live', id: String(query.ch), via: 'app' };
    if (typeof query.v === 'string' && query.v) return { kind: 'vod', id: query.v, via: 'app' };
    return null;
  }
  if (/^\/vod\/stream/.test(path) && query.videoId) return { kind: 'vod', id: vodKey(query), via: 'app' };
  return null;
}

module.exports = { ActivityTracker, streamOf, vodKey, STALE_MS };
