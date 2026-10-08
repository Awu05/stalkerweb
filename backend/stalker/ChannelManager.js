// ChannelManager.js
// Mirrors: ChannelManager.cpp
//
// Fetches and parses channels (GetOrderedList, GetAllChannels) and genres/groups.
// Handles pagination exactly as the C++ addon does.

'use strict';

const fs   = require('fs');
const path = require('path');
const log = require('../logger');
const TAG = 'ChannelManager';

// How long a resolved create_link is reused (see resolveStream). Long enough
// to cover a client's probe-then-open double fetch and a quick re-zap; short
// enough that a channel left alone re-tokenizes on the next play.
const RESOLVED_TTL_MS = 60_000;

class ChannelManager {
  constructor(client, dataDir = null) {
    this.client = client;
    this._healthFile      = dataDir ? path.join(dataDir, 'stream-health.json') : null;
    this._healthSaveTimer = null;
    this._channels = [];
    this._channelIndex = new Map();   // uniqueId → channel, for O(1) lookups
    this._legacyIndex  = new Map();   // pre-portal-id hash → channel (compat shim)
    this._groups = [];
    this._genreMap = new Map();
    this._loadGroupsPromise = null;    // deduplicates concurrent loadGroups calls
    this._loadChannelsPromise = null;  // deduplicates concurrent loadChannels calls
    this._progress = { loading: false, page: 0, totalPages: 0, channelCount: 0 };
    this._health = new Map(Object.entries(this._loadHealthFromDisk()));
    this._resolvedCache = new Map();   // cmd → { value:{url,type}, expires } — one create_link per zap
    this._resolving     = new Map();   // cmd → in-flight resolve, shared by concurrent callers
  }

  _loadHealthFromDisk() {
    if (!this._healthFile) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this._healthFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  _scheduleHealthSave() {
    if (!this._healthFile) return;
    clearTimeout(this._healthSaveTimer);
    this._healthSaveTimer = setTimeout(() => {
      try {
        const data = {};
        for (const [k, v] of this._health) data[k] = v;
        const tmp = this._healthFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, this._healthFile);
      } catch (e) {
        log.warn(TAG, `health persist failed: ${e.message}`);
      }
    }, 2000);
  }

  getProgress() { return { ...this._progress }; }

  // ── Stream health tracking ────────────────────────────────────────────────────
  recordStreamError(uniqueId) {
    // Health is keyed by the current id, so an error reported under a legacy id
    // still shows against the channel.
    const key = this.getChannel(uniqueId)?.uniqueId ?? String(uniqueId);
    const entry = this._health.get(key) || { errors: 0, lastError: null };
    entry.errors++;
    entry.lastError = new Date().toISOString();
    this._health.set(key, entry);
    this._scheduleHealthSave();
    // A failed play almost always means the cached create_link URL carries a
    // stale/expired token. Drop it so the next attempt re-tokenizes via a fresh
    // create_link — exactly like a STB, which calls create_link on every play.
    this.invalidateResolvedForChannel(uniqueId);
  }

  recordStreamSuccess(uniqueId) {
    this._health.delete(this.getChannel(uniqueId)?.uniqueId ?? String(uniqueId)); // clear errors on success
    this._scheduleHealthSave();
  }

  // ── Resolved-stream cache eviction ─────────────────────────────────────────
  // Evict the cached resolved URL for an exact target (handles catch-up, whose
  // cmd is mutated).
  invalidateResolved(channel) {
    if (!channel) return;
    this._resolvedCache.delete(channel.cmd || String(channel.uniqueId));
  }

  // Evict by uniqueId (the error/health path only has the id). Clears the live
  // (static-cmd) key, any catch-up keys (cmd + " archive=…"), and the uniqueId
  // fallback key — so a token the stream server rejected is never reused.
  invalidateResolvedForChannel(uniqueId) {
    // getChannel also accepts legacy ids, which old M3Us still play by.
    const ch = this.getChannel(uniqueId);
    if (ch?.cmd) {
      for (const key of this._resolvedCache.keys()) {
        if (key === ch.cmd || key.startsWith(`${ch.cmd} `)) this._resolvedCache.delete(key);
      }
    }
    this._resolvedCache.delete(String(uniqueId));
  }

  getHealth() {
    const result = {};
    for (const [k, v] of this._health) result[k] = v;
    return result;
  }

  // ── Load channels ──────────────────────────────────────────────────────────
  // Deduplicates concurrent calls — only one fetch runs at a time.
  // Callers that arrive while a load is in progress wait on the same promise
  // instead of resetting _channels and starting a second concurrent fetch.
  loadChannels() {
    if (!this._loadChannelsPromise) {
      this._loadChannelsPromise = this._doLoadChannels().finally(() => {
        this._loadChannelsPromise = null;
      });
    }
    return this._loadChannelsPromise;
  }

  // Mirrors ChannelManager::LoadChannels()
  // First calls GetAllChannels to seed, then pages through GetOrderedList.
  async _doLoadChannels() {
    const t0 = Date.now();
    this._channels = [];
    this._channelIndex = new Map();   // reset so stale entries don't linger during reload
    this._legacyIndex  = new Map();
    this._progress = { loading: true, page: 0, totalPages: 0, channelCount: 0 };

    log.info(TAG, 'channel load: starting');

    // Load groups first so genre names can be resolved during channel parsing.
    // Always reload groups alongside channels so they stay in sync.
    log.info(TAG, 'channel load [1/3]: fetching genres/groups (itv.get_genres)');
    await this.loadGroups();
    this._genreMap = new Map(this._groups.map((g) => [String(g.id), g.name]));
    log.info(TAG, `channel load [1/3]: ${this._groups.length} groups`);

    // Step 1: get_all_channels (seeds the basic list)
    log.info(TAG, 'channel load [2/3]: seeding list (itv.get_all_channels)');
    const allData = await this.client.itvGetAllChannels();
    if (allData?.js?.data) {
      this._parseChannels(allData);
    }
    const seededCount = this._channels.length;
    log.info(TAG, `channel load [2/3]: seeded ${seededCount} channels`);

    // Step 2: get_ordered_list (paginated, concurrent) — only when needed.
    // get_all_channels already returns the full list in one response on most
    // portals, so paging through get_ordered_list as well re-downloads every
    // channel a second time, one request per page. On large portals that is
    // hundreds of requests and trips the portal's rate limit (HTTP 429). Page
    // 1 is still fetched to learn total_items; the rest only when the seed
    // came up short (e.g. a portal that leaves some genres out of it).
    const GENRE = '*';
    const MAX_CONCURRENT     = 3;
    const RETRY_CONCURRENCY  = 2;   // ease portal contention on the retry passes
    const MAX_RETRY_ROUNDS   = 2;
    const RETRY_BACKOFF_MS   = 3000; // × round — give a rate-limited portal room

    let totalItems = 0, pagesOk = 0, pagesFailed = 0, maxPages = 0;

    // Fetch a set of pages with bounded concurrency; returns the pages that
    // failed so they can be retried. Parses each page as it arrives.
    const fetchPages = async (pageList, concurrency, label) => {
      const semaphore = new _Semaphore(concurrency);
      const failed = [];
      await Promise.all(pageList.map(async (p) => {
        await semaphore.acquire();
        try {
          const data = await this.client.itvGetOrderedList(GENRE, p);
          const before = this._channels.length;
          if (data?.js) this._parseChannels(data);
          log.debug(TAG, `channel load [3/3]${label}: page ${p}/${maxPages} ok → +${this._channels.length - before} (running total ${this._channels.length})`);
        } catch (e) {
          failed.push(p);
          log.warn(TAG, `channel load [3/3]${label}: page ${p}/${maxPages} failed: ${e.message}`);
        } finally {
          this._progress.page = Math.max(this._progress.page, p);
          this._progress.channelCount = this._channels.length;
          semaphore.release();
        }
      }));
      return failed;
    };

    const page1 = await this.client.itvGetOrderedList(GENRE, 1);
    if (page1?.js) {
      totalItems         = Number(page1.js.total_items)    || 0;
      const maxPageItems = Number(page1.js.max_page_items) || 0;
      maxPages           = totalItems > 0 && maxPageItems > 0
        ? Math.ceil(totalItems / maxPageItems)
        : 1;
      log.info(TAG, `channel load [3/3]: paging itv.get_ordered_list — ${totalItems} items over ${maxPages} page${maxPages !== 1 ? 's' : ''} (concurrency ${MAX_CONCURRENT})`);
      this._progress.totalPages = maxPages;
      this._progress.page = 1;
      const before1 = this._channels.length;
      this._parseChannels(page1);
      log.debug(TAG, `channel load [3/3]: page 1/${maxPages} ok → +${this._channels.length - before1} (running total ${this._channels.length})`);
      this._progress.channelCount = this._channels.length;

      let failed = [];
      const seedComplete = totalItems > 0 && seededCount >= totalItems;
      if (seedComplete && maxPages > 1) {
        log.info(TAG, `channel load [3/3]: get_all_channels already covered all ${totalItems} items — skipping ${maxPages - 1} get_ordered_list page(s)`);
      } else if (maxPages > 1) {
        const pages = Array.from({ length: maxPages - 1 }, (_, i) => i + 2);
        failed = await fetchPages(pages, MAX_CONCURRENT, '');

        // Retry passes for timed-out pages at lower concurrency so a transiently
        // overloaded portal doesn't silently cost us thousands of channels.
        for (let round = 1; round <= MAX_RETRY_ROUNDS && failed.length > 0; round++) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * round));
          log.info(TAG, `channel load [3/3]: retry ${round}/${MAX_RETRY_ROUNDS} — re-fetching ${failed.length} failed page(s) at concurrency ${RETRY_CONCURRENCY}`);
          failed = await fetchPages(failed, RETRY_CONCURRENCY, ` retry${round}`);
        }
      }
      pagesFailed = failed.length;
      pagesOk     = maxPages - pagesFailed;
    }

    // Deduplicate by uniqueId
    const beforeDedup = this._channels.length;
    const seen = new Set();
    this._channels = this._channels.filter((ch) => {
      if (seen.has(ch.uniqueId)) return false;
      seen.add(ch.uniqueId);
      return true;
    });
    const dupes = beforeDedup - this._channels.length;

    this._progress = { loading: false, page: this._progress.totalPages, totalPages: this._progress.totalPages, channelCount: this._channels.length };
    // Build O(1) lookup index
    this._channelIndex = new Map(this._channels.map((c) => [String(c.uniqueId), c]));
    this._legacyIndex  = new Map(this._channels
      .filter((c) => c.legacyId && c.legacyId !== c.uniqueId)
      .map((c) => [String(c.legacyId), c]));
    const withGenre = this._channels.filter((c) => c.genre).length;
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    log.info(TAG, `channel load: complete in ${dur}s — ${this._channels.length} channels (${withGenre} with genre, ${this._groups.length} groups, ${dupes} dupes removed, pages ${pagesOk} ok/${pagesFailed} failed)`);
    if (pagesFailed > 0) {
      const missing = Math.max(0, totalItems - this._channels.length);
      log.warn(TAG, `channel load: ${pagesFailed}/${maxPages} pages failed (likely timeouts) — ~${missing} of ${totalItems} channels missing. Raise connection_timeout or reduce concurrency.`);
    }
    if (this._channels.length > 0) {
      const s = this._channels[0];
      log.debug(TAG, `channel load: sample channel name=${s.name} genreId=${JSON.stringify(s.genreId)} genre=${JSON.stringify(s.genre)}`);
    }
    return this._channels;
  }

  // ── Parse channel JSON ─────────────────────────────────────────────────────
  // Mirrors ChannelManager::ParseChannels()
  _parseChannels(parsed) {
    const data = parsed?.js?.data;
    if (!data) return;

    const items = Array.isArray(data) ? data : Object.values(data);
    for (const item of items) {
      if (!item?.name) continue;

      const rawGenreId = item.tv_genre_id || '';
      const channel = {
        uniqueId: _uniqueIdFor(item),
        // What uniqueId used to be: a 32-bit hash of name+number. Two distinct
        // channels could hash alike, and the de-duplication below then dropped
        // one of them outright. Retained so ids minted by older builds —
        // favorites, per-channel stream overrides, bookmarked /proxy/stream
        // URLs, M3U tvg-ids — still resolve. See getChannel().
        legacyId: String(_channelId(item.name, item.number)),
        number: parseInt(item.number, 10) || 0,
        name: item.name,
        channelId: parseInt(item.id, 10) || 0,
        cmd: item.cmd || '',
        genreId: rawGenreId,
        genre: (this._genreMap?.get(rawGenreId) || null),
        iconPath: _determineLogoUri(this.client.getBasePath(), item.logo || ''),
        useHttpTmpLink: !!parseInt(item.use_http_tmp_link, 10),
        useLoadBalancing: !!parseInt(item.use_load_balancing, 10),
      };

      // Pages are fetched in parallel and the portal's list can shift between
      // requests, so the same channel can arrive on two pages; uniqueId is also
      // a 32-bit hash of name+number, which can collide outright. The index is a
      // Map and absorbed both silently, but _channels did not — leaving the array
      // holding duplicates the index never showed. Clients that key a list by
      // uniqueId (the Android channel list does) then crash outright on it.
      // Pages are fetched in parallel and the portal's list can shift between
      // requests, so the same channel can arrive on two pages; uniqueId is also
      // a 32-bit hash of name+number, which can collide outright. The index is a
      // Map and absorbed both silently, but _channels did not — leaving the array
      // holding duplicates the index never showed. Clients that key a list by
      // uniqueId (the Android channel list does) then crash outright on it.
      if (this._channelIndex.has(channel.uniqueId)) continue;

      this._channels.push(channel);
      // Keep indexes in sync as each page arrives so getChannel() works
      // immediately — even while loading is still in progress.
      this._channelIndex.set(channel.uniqueId, channel);
      if (channel.legacyId !== channel.uniqueId) this._legacyIndex.set(channel.legacyId, channel);
    }
  }

  // ── Load groups (genres) ───────────────────────────────────────────────────
  // Mirrors ChannelManager::LoadChannelGroups()
  // Deduplicates concurrent calls — only one fetch runs at a time.
  loadGroups() {
    if (!this._loadGroupsPromise) {
      this._loadGroupsPromise = this._doLoadGroups().finally(() => {
        this._loadGroupsPromise = null;
      });
    }
    return this._loadGroupsPromise;
  }

  async _doLoadGroups() {
    this._groups = [];
    const data = await this.client.itvGetGenres();
    if (!data?.js) return this._groups;

    const items = Array.isArray(data.js) ? data.js : Object.values(data.js);
    for (const item of items) {
      if (!item?.title) continue;
      const name = item.title.charAt(0).toUpperCase() + item.title.slice(1);
      this._groups.push({
        id: item.id || '',
        name,
        alias: item.alias || '',
      });
    }

    log.info(TAG, `loaded ${this._groups.length} groups`);
    if (this._groups.length > 0) {
      log.debug(TAG, `sample groups: ${JSON.stringify(this._groups.slice(0, 3))}`);
    }
    return this._groups;
  }

  getChannels() { return this._channels; }
  getGroups() { return this._groups; }

  // Accepts a current uniqueId or an id minted by an older build (the legacy
  // name+number hash), so stored favorites, overrides and bookmarked stream
  // URLs keep resolving after the switch to portal ids.
  getChannel(uniqueId) {
    const id = String(uniqueId);
    return this._channelIndex.get(id) ?? this._legacyIndex.get(id) ?? null;
  }

  /** Maps a legacy hash id to the current uniqueId, or null if unknown. */
  resolveLegacyId(legacyId) {
    return this._legacyIndex.get(String(legacyId))?.uniqueId ?? null;
  }

  // Resolves to the channel as soon as it is indexed, or null on timeout.
  // Handles the post-reconnect race where channelManager is empty while
  // the first page of channels is still loading from the portal.
  async waitForChannel(uniqueId, timeoutMs = 10_000) {
    const id = String(uniqueId);

    // Fast path — already in index
    const immediate = this.getChannel(id);
    if (immediate) return immediate;

    // If the list is empty and not loading, trigger a background load now
    if (this._channels.length === 0 && !this._progress.loading) {
      log.info(TAG, `waitForChannel: channel list empty — triggering background load`);
      this.loadChannels().catch(e => log.warn(TAG, `triggered load failed: ${e.message}`));
    }

    // Poll until the channel appears or loading finishes (or we time out)
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this._progress.loading) {
      await new Promise(r => setTimeout(r, 500));
      const found = this.getChannel(id);
      if (found) return found;
    }

    return this.getChannel(id);
  }

  // ── Stream resolution (cached) ────────────────────────────────────────────
  // Resolves a channel to a playable URL + a stream-type hint. One create_link
  // per zap, like a STB: /api/stream (the player's type hint), /proxy/stream,
  // and any repeat fetch of the channel URL within RESOLVED_TTL_MS reuse the
  // same link. That reuse is load-bearing: stream servers typically allow one
  // live token per account, so a second create_link invalidates the first
  // token — and many clients fetch the channel URL twice in quick succession
  // (probe, then open), which used to kill their own stream on the first
  // sub-playlist request. A token the stream server rejects is evicted
  // (recordStreamError → invalidateResolvedForChannel), so reuse never
  // outlives a dead link. Keyed by cmd so catch-up/archive (which mutates cmd)
  // and live get separate entries; concurrent callers share one in-flight
  // resolve.
  resolveStream(channel) {
    const key = channel.cmd || String(channel.uniqueId);
    const cached = this._resolvedCache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);

    const pending = this._resolving.get(key);
    if (pending) return pending;
    const p = this._resolveStreamUncached(channel, key).finally(() => this._resolving.delete(key));
    this._resolving.set(key, p);
    return p;
  }

  async _resolveStreamUncached(channel, key) {

    let url;
    if ((channel.cmd || '').includes('matrix')) {
      // Matrix channels resolve through the portal's matrix.php, not create_link.
      const raw = await this.client.resolveMatrixUrl(channel.cmd);
      url = this._rewriteLocalhost(_extractUrl(raw || ''));
    } else {
      url = await this.getStreamUrl(channel);
    }

    let type = classifyStreamType(url);

    // Content-aware typing for ambiguous (extensionless) HTTP links. Like
    // stalkerhek, which keys off the response Content-Type rather than the URL
    // extension: an extensionless link can be an HLS playlist, raw MPEG-TS, or a
    // progressive file, and guessing 'hls' from the extension misroutes raw-TS
    // channels to hls.js. ffprobe tells us the real container (and the codec
    // probe is cached, so the later /proxy/stream fetch reuses it for free).
    if (type !== 'unsupported' && _isAmbiguousHttpUrl(url)) {
      const refined = await this._refineTypeByProbe(url);
      if (refined) {
        if (refined !== type) log.info(TAG, `ch ${channel.number}: refined stream type ${type} → ${refined} via probe`);
        type = refined;
      }
    }

    const value = { url, type };
    this._resolvedCache.set(key, { value, expires: Date.now() + RESOLVED_TTL_MS });
    return value;
  }

  // Probe an ambiguous HTTP link to learn its real container. Best-effort:
  // returns null (→ keep the extension-based guess) when FFmpeg is unavailable
  // or the probe fails, so this never regresses a channel that plays today.
  async _refineTypeByProbe(url) {
    const ff = require('./FfmpegService');
    if (!ff.isAvailable()) return null;
    let headers = {};
    try { headers = this.client.streamHeadersFor(url); } catch { /* use none */ }
    const probe = await ff.probeCodecs(url, headers);
    return probe?.container || null;
  }

  // ── Stream URL resolution ─────────────────────────────────────────────────
  // Native STBemu behavior: call create_link for EVERY channel zap — not only
  // when use_http_tmp_link/use_load_balancing are set. The portal re-tokenizes
  // the link on every play (temp-link tokens, load-balancer host, CDN auth), so
  // playing channel.cmd directly serves a stale/un-tokenized URL that some
  // portals reject with 403 even though the channel plays fine in STBemu.
  // Falls back to the static channel.cmd only if create_link yields nothing.
  async getStreamUrl(channel) {
    let cmd = '';
    log.info(TAG, `resolve: ch ${channel.number} create_link cmd="${channel.cmd}"`);
    try {
      const linkData = await this.client.itvCreateLink(channel.cmd);
      log.debug(TAG, `ch ${channel.number}: create_link raw js=${JSON.stringify(linkData?.js)}`);
      // Portals differ: some use js.cmd, others js.url, some return js as a string
      if (linkData?.js?.cmd) {
        cmd = linkData.js.cmd;
      } else if (linkData?.js?.url) {
        cmd = linkData.js.url;
      } else if (typeof linkData?.js === 'string' && linkData.js) {
        cmd = linkData.js;
      } else {
        log.warn(TAG, `ch ${channel.number}: create_link returned no recognisable cmd field, raw js=${JSON.stringify(linkData?.js)}`);
      }
    } catch (e) {
      log.warn(TAG, `ch ${channel.number}: create_link threw (${e.message}), falling back to direct cmd`);
    }

    if (!cmd) {
      log.warn(TAG, `ch ${channel.number}: create_link yielded no cmd, falling back to channel.cmd="${channel.cmd}"`);
      cmd = channel.cmd;
    }

    // cmd format: "ffrt<n> <url>" / "ffmpeg <url>" / "auto <url>" → url after first space
    const url = this._rewriteLocalhost(_extractUrl(cmd));
    log.info(TAG, `resolve: ch ${channel.number} → ${url || '(empty)'}`);
    return url;
  }

  // The channel's own (un-tokenized) cmd, resolved the same way as a create_link
  // result. Some portals hand out channel cmds that already carry a working
  // play_token/stream id and their create_link endpoint actually clobbers it
  // (e.g. returns stream=<blank> with a fresh token that the CDN then 405s on)
  // — this lets the proxy retry against the original link when create_link's
  // result turns out to be broken.
  getRawStreamUrl(channel) {
    return this._rewriteLocalhost(_extractUrl(channel.cmd || ''));
  }

  // Stalker portals sometimes return a stream whose host is localhost/127.0.0.1
  // (the portal proxies it on its own box). A remote client must rewrite that to
  // the portal's public host — STBemu and pvr.stalker/stalkerhek all do this.
  _rewriteLocalhost(url) {
    if (!url || !/^https?:\/\//i.test(url)) return url;
    try {
      const u = new URL(url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
        const portal = new URL(this.client.getBasePath());
        u.protocol = portal.protocol;
        u.host = portal.host;
        const rewritten = u.toString();
        log.info(TAG, `rewrote localhost stream host → ${portal.host}`);
        return rewritten;
      }
    } catch { /* not a parseable URL — leave as-is */ }
    return url;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Strip the leading "solution" token from a Stalker cmd:
//   "ffrt2 http://..."  → "http://..."
//   "ffmpeg http://..." → "http://..."
//   "http://..."        → "http://..."  (no token)
function _extractUrl(cmd) {
  if (!cmd) return '';
  const sp = cmd.indexOf(' ');
  return (sp !== -1 ? cmd.slice(sp + 1) : cmd).trim();
}

// True for an http(s) URL whose path carries no recognisable container hint, so
// classifyStreamType can only guess. These are the links worth probing for their
// real type (mirrors stalkerhek inspecting the response Content-Type).
function _isAmbiguousHttpUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  const path = url.toLowerCase().split('?')[0].split('#')[0];
  if (/\.(m3u8|m3u|mp4|mkv|mov|avi|webm|ts|mpegts|mpg|mpeg)$/.test(path)) return false;
  if (/\/(udp|rtp)\//.test(path)) return false; // already resolves to mpegts
  return true;
}

// Classify a resolved stream URL so the player can pick the right engine:
//   'hls'         → HLS playlist (hls.js)
//   'mpegts'      → raw MPEG-TS over HTTP (mpegts.js — what a STB feeds to ffmpeg)
//   'native'      → progressive MP4/MKV/etc (native <video>)
//   'unsupported' → udp/rtp/rtsp — a browser cannot fetch these without a
//                   server-side ffmpeg remux (not implemented)
function classifyStreamType(url) {
  if (!url) return 'unsupported';
  const lower = url.toLowerCase();
  if (/^(udp|rtp|rtsp|mc|igmp):\/\//.test(lower)) return 'unsupported';
  const [pathPart, queryPart] = lower.split('#')[0].split('?');
  if (/\.(m3u8|m3u)$/.test(pathPart)) return 'hls';
  if (/\.(mp4|mkv|mov|avi|webm)$/.test(pathPart)) return 'native';
  if (/\.(ts|mpegts|mpg|mpeg)$/.test(pathPart)) return 'mpegts';
  // Raw MPEG-TS gateways commonly expose multicast over HTTP as /udp/239.x or /rtp/
  if (/\/(udp|rtp)\//.test(pathPart)) return 'mpegts';
  // Some portals (e.g. cf.business-cdn-8k.com-style CDNs) put the real container
  // in an `extension=` query param instead of the path itself — a link like
  // .../live.php?...&extension=ts is raw MPEG-TS even though the path has no
  // extension. Trust that explicit hint before falling back to the blind guess.
  if (queryPart) {
    const ext = new URLSearchParams(queryPart).get('extension');
    if (ext === 'ts' || ext === 'mpegts' || ext === 'mpg' || ext === 'mpeg') return 'mpegts';
    if (ext === 'm3u8' || ext === 'm3u') return 'hls';
    if (ext === 'mp4' || ext === 'mkv' || ext === 'mov' || ext === 'avi' || ext === 'webm') return 'native';
  }
  // Unknown/extensionless — most Stalker live links are HLS; default there. The
  // proxy sniffs the actual bytes regardless, and the player falls back if wrong.
  return 'hls';
}

// Mirrors ChannelManager::GetChannelId() — djb2 hash of name+number
// The portal's own channel id is unique by construction, so prefer it. Some
// portals omit it; fall back to the historical name+number hash there rather
// than minting a colliding zero. Kept numeric so /api/epg/:channelId, which
// parseInt()s the path segment, still works.
function _uniqueIdFor(item) {
  const portalId = String(item.id ?? '').trim();
  if (/^\d+$/.test(portalId) && portalId !== '0') return portalId;
  return String(_channelId(item.name, item.number));
}

function _channelId(name, number) {
  const str = String(name) + String(number);
  let id = 0;
  for (let i = 0; i < str.length; i++) {
    id = ((id << 5) + id) + str.charCodeAt(i); // id * 33 + c
    id = id & id; // force 32-bit
  }
  return Math.abs(id);
}

class _Semaphore {
  constructor(max) { this._max = max; this._count = 0; this._queue = []; }
  acquire() {
    return new Promise((resolve) => {
      if (this._count < this._max) { this._count++; resolve(); }
      else this._queue.push(resolve);
    });
  }
  release() {
    this._count--;
    if (this._queue.length) { this._count++; this._queue.shift()(); }
  }
}

// Mirrors Utils::DetermineLogoURI()
// Mirrors pvr.stalker's Utils::DetermineLogoURI. Portals return the `logo`
// field as a bare filename (e.g. "1485275651.png") whose image lives under the
// portal's 320px logo directory, so a bare name must be prefixed with
// SC_ITV_LOGO_PATH_320 = "misc/logos/320/". basePath ends in a slash
// (e.g. "http://host/stalker_portal/").
const ITV_LOGO_PATH_320 = 'misc/logos/320/';
function _determineLogoUri(basePath, logo) {
  if (!logo) return '';
  if (logo.startsWith('data:')) return '';            // data URIs aren't usable as <img src> here
  if (logo.includes('://')) return logo;              // already absolute (any scheme)
  // Absolute path on the portal host → join to the origin, not the deeper base
  // path (which would duplicate the portal path segment).
  if (logo.startsWith('/')) {
    try { return new URL(basePath).origin + logo; }
    catch { return basePath.replace(/\/$/, '') + logo; }
  }
  // Bare filename → portal logo directory. Skip the prefix if the value already
  // carries a misc/logos path so we don't double it.
  if (/(^|\/)misc\/logos\//.test(logo)) return basePath + logo;
  return basePath + ITV_LOGO_PATH_320 + logo;
}

module.exports = ChannelManager;
module.exports.classifyStreamType = classifyStreamType;
