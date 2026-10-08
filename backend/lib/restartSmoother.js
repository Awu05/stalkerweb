'use strict';

// Keeps a live HLS playlist steady for players across source restarts.
//
// Some portal stream servers restart a channel every minute or two, and a
// restart upsets the media playlist in two ways (both measured on a Flussonic
// server):
//   • it repeats content: the segments after the break start seconds before
//     the end of what was already listed — 5 s of 6 in one case, 20 s in
//     another — so every player (hls.js, FFmpeg in Jellyfin, VLC) replays it;
//   • it renumbers: #EXT-X-MEDIA-SEQUENCE jumps ten or more ahead with no new
//     content, so players think they fell behind and jump, or ask for numbers
//     that now mean other segments.
//
// The proxy passes each live media playlist through rewrite(), which gives
// players their own numbering: each new segment gets the next number the
// first time it appears, whatever number the source gave it, and keeps it.
// A new segment that mostly repeats content already listed is left out — a
// skip of a second instead of a replay. Where a segment starts is read from
// its name when the server names segments by time (Flussonic:
// …/2026/10/08/20/42/14-06474.ts = 20:42:14, 6.474 s), otherwise, after a
// discontinuity only, from the timestamps at its start (from segments
// already served, or a small probe).
//
// Anything uncertain (no timestamps, a probe that fails or is slow, a clock
// that jumped somewhere unrelated) keeps the segment: the worst case is the
// replay this was meant to hide. Playlists it can't follow segment by segment
// (byte ranges, low-latency parts) pass through untouched.

const log = require('../logger');
const TAG = 'restart-smoother';

const OVERLAP_MIN_S = 1.0;       // a repeat shorter than this isn't worth a skip
const OVERLAP_FRACTION = 0.5;    // …and it must be most of the segment
const MAX_REPEAT_S = 60;         // further back than this is a clock change, not a repeat
const MAX_HOLD_S = 45;           // never leave out more than this in a row — resync instead
const PROBE_TIMEOUT_MS = 3000;
const KEEP_HISTORY = 300;        // segments of state kept per stream

const HEADER_TAGS = new Set([
  '#EXTM3U', '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-PLAYLIST-TYPE', '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-ALLOW-CACHE', '#EXT-X-START', '#EXT-X-SERVER-CONTROL', '#EXT-X-PART-INF',
]);
// Tags that belong to the segment itself and go away with it; any other
// per-segment tag (key, map) moves on to the next kept one. Discontinuities
// are tracked separately.
const OWN_TAGS = ['#EXTINF', '#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-BYTERANGE', '#EXT-X-GAP', '#EXT-X-DISCONTINUITY'];
// Playlists whose segments aren't one file each — passed through.
const UNFOLLOWABLE = /#EXT-X-(?:BYTERANGE|PART):/;

const tagName = (line) => line.split(':')[0];
const pathOf = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } };

// Start time and length (seconds) from a time-based segment name, or null.
// Flussonic: <name>/YYYY/MM/DD/HH/MM/SS-<duration ms>.ts
const TIME_NAME = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})-(\d+)\.(?:ts|m4s|mp4|aac)(?:$|\?)/;
function timeFromName(uri) {
  const m = TIME_NAME.exec(uri);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m.map(Number);
  return { start: Date.UTC(y, mo - 1, d, h, mi, s) / 1000, dur: ms / 1000 };
}
const discontinuitySequence = (parsed) =>
  Number(parsed.header.find((l) => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))?.split(':')[1] ?? 0) || 0;
const clockOf = (start) => new Date(start * 1000).toISOString().slice(11, 19);

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
   * @param {(ch: string, seq: number) => void} [opts.onDrop]
   *   a segment the source numbered `seq` was left out
   */
  constructor({ probe, onDrop = () => {}, logger = log, probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
    this.probe = probe;
    this.onDrop = onDrop;
    this.log = logger;
    this.probeTimeoutMs = probeTimeoutMs;
    this.pts = new Map();      // segment path → start timestamp (s)
    this.streams = new Map();  // stream key → state (see _stream)
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
    if (!st) {
      st = {
        kept: new Map(),      // segment path → { out, upSeq, url, dur, time, disc, dseq, carry }
        dropped: new Map(),   // segment path → source number
        nextOut: null,        // number the next kept segment gets
        last: null,           // newest kept segment
        discs: 0,             // discontinuities handed out so far
        pending: { disc: false, tags: [] },   // carried over from left-out segments
        offset: 0,            // source number − ours, last seen (for the renumber log)
        held: 0,              // seconds left out since the last kept segment
        lastBody: null,
      };
      this.streams.set(key, st);
    }
    return st;
  }

  /**
   * The playlist players should see, for live media playlist `body` fetched
   * from `playlistUrl` (segment URIs stay as the server wrote them; the proxy
   * rewrites them afterwards). `channel` names the channel in logs.
   */
  async rewrite(streamKey, playlistUrl, body, channel = streamKey) {
    if (UNFOLLOWABLE.test(body)) return body;
    const parsed = parsePlaylist(body);
    if (!parsed || !parsed.segments.length) return body;
    const abs = (uri) => { try { return new URL(uri, playlistUrl).toString(); } catch { return uri; } };
    const ids = parsed.segments.map((seg) => pathOf(abs(seg.uri)));
    if (new Set(ids).size !== ids.length) return body;   // one file listed twice: not followable

    const st = this._stream(streamKey);
    if (st.nextOut === null) {
      // Start from the source's numbers, so a stream without restarts passes through as is.
      st.nextOut = parsed.segments[0].seq;
      st.discs = discontinuitySequence(parsed);
    }

    const leftOut = [];
    for (const [i, seg] of parsed.segments.entries()) {
      const id = ids[i];
      const known = st.kept.get(id);
      if (known) { known.url = abs(seg.uri); continue; }
      if (st.dropped.has(id)) continue;
      const url = abs(seg.uri);
      const time = timeFromName(url);
      const repeat = st.last ? await this._repeat(st.last, seg, url, time) : null;
      if (repeat !== null && st.held + repeat <= MAX_HOLD_S) {
        st.held += repeat;
        st.dropped.set(id, seg.seq);
        if (seg.disc) st.pending.disc = true;
        st.pending.tags.push(...seg.tags.filter((t) => !OWN_TAGS.includes(tagName(t))));
        leftOut.push({ seg, time, repeat });
        this.onDrop(channel, seg.seq);
        continue;
      }
      st.held = 0;
      // Kept after a long run of repeats: the source isn't catching up, so its
      // clock moved for good — players get the break marked and carry on.
      const disc = seg.disc || st.pending.disc || repeat !== null;
      if (disc) st.discs++;
      const entry = {
        out: st.nextOut++, upSeq: seg.seq, url, dur: seg.dur, time,
        disc, dseq: st.discs, carry: st.pending.tags,
      };
      st.pending = { disc: false, tags: [] };
      st.kept.set(id, entry);
      st.last = entry;
    }
    if (leftOut.length) this._logLeftOut(channel, leftOut);
    this._noteRenumber(st, parsed, ids, channel);
    this._prune(st);

    const out = this._render(parsed, ids, st, body);
    if (out === null) return st.lastBody ?? body;   // nothing new to show yet: keep the last playlist
    st.lastBody = out;
    return out;
  }

  // How much of `seg` repeats content up to the end of `prev` (seconds), when
  // that is enough to leave it out; null to keep it.
  async _repeat(prev, seg, url, time) {
    let prevStart, prevDur, curStart, dur;
    if (time && prev.time) {
      // Times from the names are one clock across restarts: anything shortly
      // before the end of what was listed is a repeat.
      ({ start: prevStart, dur: prevDur } = prev.time);
      ({ start: curStart, dur } = time);
      if (prevStart + prevDur - curStart > MAX_REPEAT_S) return null;
    } else if (seg.disc) {
      // Stream timestamps reset at restarts, so only a start just after the
      // previous one is clearly a repeat; a clock that jumped elsewhere isn't.
      prevStart = await this._ptsOf(prev.url);
      curStart = await this._ptsOf(url);
      prevDur = prev.dur;
      dur = seg.dur || prev.dur;
      if (prevStart === null || curStart === null || curStart < prevStart - 1) return null;
    } else {
      return null;
    }
    if (!prevDur || !dur) return null;
    const overlap = prevStart + prevDur - curStart;
    return overlap >= OVERLAP_MIN_S && overlap >= dur * OVERLAP_FRACTION ? Math.min(overlap, dur) : null;
  }

  _logLeftOut(channel, list) {
    const total = list.reduce((sum, l) => sum + l.repeat, 0);
    const what = list.length === 1 ? `segment ${list[0].seg.seq}` : `${list.length} segments (${list[0].seg.seq}–${list.at(-1).seg.seq})`;
    const when = list[0].time ? ` from ${clockOf(list[0].time.start)}` : '';
    this.log.info(TAG, `ch ${channel}: left out ${what}${when} after a source restart — ${total.toFixed(1)}s of content already played`);
  }

  // The source changed its numbering for segments it had already listed.
  _noteRenumber(st, parsed, ids, channel) {
    for (const [i, seg] of parsed.segments.entries()) {
      const e = st.kept.get(ids[i]);
      if (!e) continue;
      const offset = seg.seq - e.upSeq;
      if (offset !== st.offset) {
        this.log.info(TAG, `ch ${channel}: the source renumbered its segments (${offset > st.offset ? '+' : ''}${offset - st.offset}) — players keep their numbering`);
        st.offset = offset;
      }
      return;
    }
  }

  // Forget segments far behind the live window.
  _prune(st) {
    if (!st.last) return;
    const floor = st.last.out - KEEP_HISTORY;
    for (const [id, e] of st.kept) if (e.out < floor) st.kept.delete(id);
    while (st.dropped.size > KEEP_HISTORY) st.dropped.delete(st.dropped.keys().next().value);
  }

  // The playlist in our numbering: kept segments of this window in order,
  // from the newest back to the first gap (a kept segment the source no
  // longer lists — HLS numbers must run without holes). Null if none.
  _render(parsed, ids, st, body) {
    const rows = parsed.segments
      .map((seg, i) => ({ seg, e: st.kept.get(ids[i]) }))
      .filter((r) => r.e)
      .sort((a, b) => a.e.out - b.e.out);
    if (!rows.length) return null;
    let from = rows.length - 1;
    while (from > 0 && rows[from - 1].e.out === rows[from].e.out - 1) from--;
    const win = rows.slice(from);

    // Untouched when it would come out the same.
    const first = win[0];
    const dseq = first.e.dseq;
    const same = win.length === parsed.segments.length && first.e.out === parsed.segments[0].seq &&
      dseq === discontinuitySequence(parsed) + (parsed.segments[0].disc ? 1 : 0) &&
      win.every((r, i) => r.seg === parsed.segments[i] && r.e.disc === r.seg.disc && !r.e.carry.length);
    if (same) return body;

    const header = parsed.header.filter((l) => !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))
      .flatMap((l) => (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')
        ? [`#EXT-X-MEDIA-SEQUENCE:${first.e.out}`, ...(dseq ? [`#EXT-X-DISCONTINUITY-SEQUENCE:${dseq}`] : [])]
        : [l]));
    const lines = [];
    for (const [i, { seg, e }] of win.entries()) {
      // The first segment's discontinuity is counted in the header.
      if (e.disc && i > 0) lines.push('#EXT-X-DISCONTINUITY');
      const tags = [...new Set([...e.carry, ...seg.tags.filter((t) => t !== '#EXT-X-DISCONTINUITY')])];
      lines.push(...tags, seg.uri);
    }
    return [...header, ...lines, ...parsed.trailer].join('\n') + '\n';
  }
}

module.exports = { RestartSmoother, parsePlaylist, timeFromName };
