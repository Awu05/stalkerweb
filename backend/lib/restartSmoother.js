'use strict';

// Hides the replay a live source causes when it restarts.
//
// Some portal stream servers restart a channel every minute or two. The media
// playlist marks it with #EXT-X-DISCONTINUITY, and the first segment after the
// break starts only a fraction of a second after the previous segment did —
// so it repeats almost all of what was just played (4–5 s of 6 s, measured).
// Every player (hls.js, FFmpeg in Jellyfin, VLC) plays it, and the viewer sees
// a few seconds replay.
//
// The proxy passes each live media playlist through rewrite(). For the first
// segment after a break it reads the timestamps at the start of that segment
// and of the last segment kept before it (from segments already served, or a
// small probe), and when the new segment mostly repeats content that was
// already delivered it is left out of the playlist — a skip of about a second
// instead of a replay of five. Segments are renumbered in the playlist players
// see, so leaving one out never shifts the numbering of the others.
//
// Anything uncertain (no timestamps, a probe that fails or is slow, a clock
// that jumped somewhere unrelated) keeps the segment: the worst case is the
// replay this was meant to hide.

const log = require('../logger');
const TAG = 'restart-smoother';

const OVERLAP_MIN_S = 1.0;       // a repeat shorter than this isn't worth a skip
const OVERLAP_FRACTION = 0.5;    // …and it must be most of the segment
const PROBE_TIMEOUT_MS = 3000;
const KEEP_HISTORY = 300;        // segments of state kept per stream

const HEADER_TAGS = new Set([
  '#EXTM3U', '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-PLAYLIST-TYPE', '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-ALLOW-CACHE', '#EXT-X-START', '#EXT-X-SERVER-CONTROL', '#EXT-X-PART-INF',
]);
// Tags that belong to the segment itself and go away with it; any other
// per-segment tag (discontinuity, key, map) moves on to the next kept one.
const OWN_TAGS = ['#EXTINF', '#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-BYTERANGE', '#EXT-X-GAP'];

const tagName = (line) => line.split(':')[0];
const pathOf = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } };

/** Splits a media playlist into header lines, segments and trailer lines; null if not one. */
function parsePlaylist(body) {
  const lines = body.split(/\r?\n/);
  const seqLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  if (!seqLine) return null;
  let seq = Number(seqLine.split(':')[1]);
  const header = [];
  const segments = [];
  const trailer = [];
  let tags = [];
  let inSegments = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '#EXT-X-ENDLIST') { trailer.push(line); continue; }
    if (!inSegments && line.startsWith('#') && HEADER_TAGS.has(tagName(line))) { header.push(line); continue; }
    inSegments = true;
    if (line.startsWith('#')) { tags.push(line); continue; }
    const extinf = tags.find((t) => t.startsWith('#EXTINF:'));
    segments.push({
      seq: seq++,
      uri: line,
      tags,
      dur: extinf ? parseFloat(extinf.slice(8)) : null,
      disc: tags.includes('#EXT-X-DISCONTINUITY'),
    });
    tags = [];
  }
  return { header, segments, trailer };
}

class RestartSmoother {
  /**
   * @param {object} opts
   * @param {(url: string) => Promise<{video:number|null,audio:number|null}|null>} opts.probe
   *   reads the start timestamps of a segment (the proxy fetches its first bytes)
   * @param {(ch: string, seq: number, why: string) => void} [opts.onDrop]
   */
  constructor({ probe, onDrop = () => {}, logger = log, probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
    this.probe = probe;
    this.onDrop = onDrop;
    this.log = logger;
    this.probeTimeoutMs = probeTimeoutMs;
    this.pts = new Map();      // segment path → start timestamp (s)
    this.streams = new Map();  // stream key → { verdicts: Map<seq, 'keep'|'drop'>, dropped: number[] }
  }

  /** Start timestamps of a segment the proxy served (from its diagnostics scan). */
  recordPts(url, { video, audio }) {
    const ts = video ?? audio;
    if (ts === null || ts === undefined) return;
    this.pts.set(pathOf(url), ts);
    if (this.pts.size > 2000) this.pts.delete(this.pts.keys().next().value);
  }

  async _ptsOf(url) {
    const key = pathOf(url);
    if (this.pts.has(key)) return this.pts.get(key);
    let timer;
    try {
      const ts = await Promise.race([
        this.probe(url),
        new Promise((r) => { timer = setTimeout(() => r(null), this.probeTimeoutMs); }),
      ]);
      const start = ts?.video ?? ts?.audio ?? null;
      if (start !== null) this.pts.set(key, start);
      return start;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _stream(key) {
    let st = this.streams.get(key);
    if (!st) { st = { verdicts: new Map(), dropped: [], kept: new Map() }; this.streams.set(key, st); }
    return st;
  }

  /**
   * The playlist players should see, for live media playlist `body` fetched
   * from `playlistUrl` (segment URIs stay as the CDN wrote them; the proxy
   * rewrites them afterwards). `channel` names the channel in logs.
   */
  async rewrite(streamKey, playlistUrl, body, channel = streamKey) {
    const parsed = parsePlaylist(body);
    if (!parsed || !parsed.segments.length) return body;
    const st = this._stream(streamKey);
    const abs = (uri) => { try { return new URL(uri, playlistUrl).toString(); } catch { return uri; } };

    // The last kept segment before the window, if remembered: { url, dur }.
    let prevKept = null;
    for (const seg of parsed.segments) {
      let verdict = st.verdicts.get(seg.seq);
      if (!verdict) {
        verdict = 'keep';
        const prev = prevKept ?? st.kept.get(seg.seq - 1) ?? null;
        if (seg.disc && prev) verdict = await this._judge(channel, seg, abs(seg.uri), prev);
        st.verdicts.set(seg.seq, verdict);
        if (verdict === 'drop') {
          st.dropped.push(seg.seq);
          this.onDrop(channel, seg.seq);
        }
      }
      if (verdict === 'keep') {
        prevKept = { url: abs(seg.uri), dur: seg.dur };
        st.kept.set(seg.seq, prevKept);
      }
    }
    this._prune(st, parsed.segments[0].seq);
    // Unchanged only while nothing was ever dropped on this stream: after a
    // drop every later segment is renumbered, even once the dropped one has
    // left the window.
    if (!st.dropped.length && !st.base) return body;
    return this._render(parsed, st);
  }

  async _judge(channel, seg, url, prev) {
    const [prevStart, curStart] = [await this._ptsOf(prev.url), await this._ptsOf(url)];
    if (prevStart === null || curStart === null || !prev.dur) return 'keep';
    const overlap = prevStart + prev.dur - curStart;
    const dur = seg.dur || prev.dur;
    // A repeat: the new segment starts inside the previous one. A clock that
    // jumped anywhere else (far back, or forward) isn't a repeat — keep it.
    const repeats = curStart >= prevStart - 1 && overlap >= OVERLAP_MIN_S && overlap >= dur * OVERLAP_FRACTION;
    if (!repeats) return 'keep';
    this.log.info(TAG, `ch ${channel}: left out segment ${seg.seq} after a source restart — it repeated ${overlap.toFixed(1)}s already played (skipping ${Math.max(0, dur - overlap).toFixed(1)}s instead)`);
    return 'drop';
  }

  // Forget segments far behind the live window.
  _prune(st, firstSeq) {
    const floor = firstSeq - KEEP_HISTORY;
    for (const map of [st.verdicts, st.kept]) {
      for (const seq of map.keys()) if (seq < floor) map.delete(seq);
    }
    // Drops below the floor still count for numbering; collapse them into a base.
    const below = st.dropped.filter((s) => s < floor).length;
    if (below) { st.base = (st.base ?? 0) + below; st.dropped = st.dropped.filter((s) => s >= floor); }
  }

  // Playlist without the dropped segments, numbered so each kept segment
  // always gets the same sequence number: CDN number minus the drops before it.
  _render(parsed, st) {
    const droppedBefore = (seq) => (st.base ?? 0) + st.dropped.filter((d) => d < seq).length;
    const out = [];
    let carry = [];
    let first = null;
    for (const seg of parsed.segments) {
      if (st.verdicts.get(seg.seq) === 'drop') {
        carry.push(...seg.tags.filter((t) => !OWN_TAGS.includes(tagName(t))));
        continue;
      }
      if (first === null) first = seg.seq - droppedBefore(seg.seq);
      const tags = [...new Set([...carry, ...seg.tags])];
      carry = [];
      out.push(...tags, seg.uri);
    }
    if (first === null) return parsed.header.concat(parsed.trailer).join('\n') + '\n';
    const header = parsed.header.map((l) => (l.startsWith('#EXT-X-MEDIA-SEQUENCE:') ? `#EXT-X-MEDIA-SEQUENCE:${first}` : l));
    return [...header, ...out, ...parsed.trailer].join('\n') + '\n';
  }
}

module.exports = { RestartSmoother, parsePlaylist };
