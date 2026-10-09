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
// skip of a second instead of a replay. Whether it repeats is read from the
// timestamps at its start (from segments already served, or a small probe),
// checked after a discontinuity, or when the server names segments by time
// (Flussonic: …/2026/10/08/20/42/14-06474.ts = 20:42:14, 6.474 s) and the
// names overlap. Names alone are never trusted: servers behind one address
// can label the same content differently.
//
// Anything uncertain (no timestamps, a probe that fails or is slow, a clock
// that jumped somewhere unrelated) keeps the segment: the worst case is the
// replay this was meant to hide. Playlists it can't follow segment by segment
// (byte ranges, low-latency parts) pass through untouched. A playlist made
// only of segments that already left the window (an out-of-step server) gets
// the last playlist instead; a file name the source reuses for new content
// gets a new number.

const log = require('../logger');
const TAG = 'restart-smoother';

const OVERLAP_MIN_S = 1.0;       // a repeat shorter than this isn't worth a skip
const OVERLAP_FRACTION = 0.5;    // …and it must be most of the segment
const MAX_REPEAT_S = 60;         // further back than this is a clock change, not a repeat
const NAME_AGREE_S = 2;          // names and timestamps agreeing on a long repeat, within this
const MAX_HOLD_S = 45;           // never leave out more than this in a row — resync instead
const STALL_TARGETS = 2.5;       // …nor keep players without a new segment for longer than this many target durations
const PROBE_TIMEOUT_MS = 3000;
const KEEP_HISTORY = 300;        // segments remembered behind the window, per stream
const IDLE_FORGET_MS = 30 * 60 * 1000;   // a stream nobody reloaded for this long is forgotten
const STALE_RESYNC = 3;          // older playlists in a row before starting over
const RECENT_PLAYLISTS = 3;      // a segment listed in one of the last this-many playlists is current

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
   * @param {(url: string, channel: string) => Promise<{video:number|null,audio:number|null}|null>} opts.probe
   *   reads the start timestamps of a segment (the proxy fetches its first bytes,
   *   on the channel's connection)
   * @param {(ch: string, seq: number) => void} [opts.onDrop]
   *   a segment the source numbered `seq` was left out
   */
  constructor({ probe, onDrop = () => {}, logger = log, probeTimeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {}) {
    this.probe = probe;
    this.onDrop = onDrop;
    this.log = logger;
    this.probeTimeoutMs = probeTimeoutMs;
    this.now = now;
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

  async _ptsOf(url, channel) {
    const key = pathOf(url);
    if (this.pts.has(key)) return this.pts.get(key);
    let timer;
    try {
      const ts = await Promise.race([
        this.probe(url, channel),
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
        kept: new Map(),      // segment path → { out, upSeq, url, dur, time, disc, dseq, seen }
        dropped: new Map(),   // segment path → { seq, seen }
        gen: 0,               // playlists handled; `seen` is the last one listing a segment
        nextOut: null,        // number the next kept segment gets
        last: null,           // newest kept segment
        lastNewAt: 0,         // when a segment was last kept
        discs: 0,             // discontinuities handed out so far
        pendingDisc: false,   // a left-out segment's discontinuity, for the next kept one
        held: 0,              // seconds left out since the last kept segment
        firstOut: null,       // our number of the first segment in the last playlist served
        staleRun: 0,          // playlists in a row with nothing past what was served
        lastBody: null,
        queue: Promise.resolve(),
      };
      this.streams.set(key, st);
    }
    st.usedAt = this.now();
    return st;
  }

  /**
   * The playlist players should see, for live media playlist `body` fetched
   * from `playlistUrl` (segment URIs stay as the server wrote them; the proxy
   * rewrites them afterwards). `channel` names the channel in logs.
   */
  rewrite(streamKey, playlistUrl, body, channel = streamKey) {
    this._forgetIdle();
    const st = this._stream(streamKey);
    // One reload at a time per stream (players of one channel share it): a
    // decision still waiting on a probe must be seen by the next reload, or
    // both would number the same segment.
    const run = st.queue.then(() => this._rewrite(st, playlistUrl, body, channel));
    st.queue = run.catch(() => {});
    return run;
  }

  _forgetIdle() {
    const cutoff = this.now() - IDLE_FORGET_MS;
    for (const [key, st] of this.streams) if (st.usedAt < cutoff) this.streams.delete(key);
  }

  async _rewrite(st, playlistUrl, body, channel) {
    if (UNFOLLOWABLE.test(body)) return body;
    const parsed = parsePlaylist(body);
    if (!parsed || !parsed.segments.length) return body;
    const abs = (uri) => { try { return new URL(uri, playlistUrl).toString(); } catch { return uri; } };
    const ids = parsed.segments.map((seg) => pathOf(abs(seg.uri)));
    if (new Set(ids).size !== ids.length) return body;   // one file listed twice: not followable
    const target = Number(parsed.header.find((l) => l.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1]) || 6;

    if (st.nextOut === null) {
      // Start from the source's numbers, so a stream without restarts passes through as is.
      st.nextOut = parsed.segments[0].seq;
      st.discs = discontinuitySequence(parsed);
      st.lastNewAt = this.now();
    }
    if (st.staleRun >= STALE_RESYNC) {
      // Only older playlists for a while: start over, numbering on from where
      // players are, with the break marked.
      this.log.info(TAG, `ch ${channel}: the source kept sending older playlists — starting over`);
      Object.assign(st, { kept: new Map(), dropped: new Map(), last: null, firstOut: null, staleRun: 0, pendingDisc: true, held: 0 });
    }
    const gen = ++st.gen;
    const recent = (e) => e.seen >= gen - RECENT_PLAYLISTS;

    // Where this playlist meets what was served: the segments listed recently.
    // Anything before them is older content (an out-of-step server's older
    // playlist) and is never numbered; anything after them is new.
    let firstCur = -1;
    let lastCur = -1;
    for (const [i, id] of ids.entries()) {
      const e = st.kept.get(id);
      if (e && recent(e)) { if (firstCur < 0) firstCur = i; lastCur = i; }
    }
    // Only segments that had left the window: an older playlist. (A playlist
    // of nothing but the repeats just left out is not one — that's the source
    // still catching up, and it gets the last playlist below without counting
    // towards starting over, which would serve those repeats after all.)
    const older = (id) => st.kept.has(id) || (st.dropped.has(id) && !recent(st.dropped.get(id)));
    if (firstCur < 0 && st.lastBody && ids.some((id) => st.kept.has(id)) && ids.every(older)) {
      st.gen--;
      st.staleRun++;
      return st.lastBody;
    }

    const leftOut = [];
    let renumbered = null;
    let prevOut = null;   // our number of the last kept segment so far in this playlist
    for (const [i, seg] of parsed.segments.entries()) {
      if (i < firstCur) continue;
      const id = ids[i];
      const url = abs(seg.uri);
      let known = st.kept.get(id);
      // A remembered name listed after the recent segments, or after newer
      // ones, is the source reusing a file name (names that wrap, an encoder
      // counting from 0 again) for new content.
      if (known && ((i > lastCur && !recent(known)) || (prevOut !== null && known.out <= prevOut))) {
        st.kept.delete(id);
        known = null;
      }
      if (known) {
        if (renumbered === null && seg.seq !== known.upSeq) renumbered = seg.seq - known.upSeq;
        Object.assign(known, { upSeq: seg.seq, url, seen: gen });
        prevOut = known.out;
        continue;
      }
      const drop = st.dropped.get(id);
      if (drop && recent(drop)) { drop.seen = gen; continue; }
      st.dropped.delete(id);   // not listed for a while: judged afresh

      const time = timeFromName(url);
      const repeat = st.last ? await this._repeat(st.last, seg, url, time, channel) : null;
      // Never hold the playlist still so long that players give up on it
      // (ExoPlayer: 3.5 target durations) — resync instead.
      const stalled = this.now() - st.lastNewAt > STALL_TARGETS * target * 1000;
      if (repeat !== null && st.held + repeat <= MAX_HOLD_S && !stalled) {
        st.held += repeat;
        st.dropped.set(id, { seq: seg.seq, seen: gen });
        if (seg.disc) st.pendingDisc = true;
        leftOut.push({ seg, time, repeat });
        this.onDrop(channel, seg.seq);
        continue;
      }
      // Kept after a run of repeats: the source isn't catching up, so its
      // clock moved for good — players get the break marked and carry on.
      const disc = seg.disc || st.pendingDisc || repeat !== null;
      if (disc) st.discs++;
      const entry = { out: st.nextOut++, upSeq: seg.seq, url, dur: seg.dur, time, disc, dseq: st.discs, seen: gen };
      st.held = 0;
      st.pendingDisc = false;
      st.lastNewAt = this.now();
      st.kept.set(id, entry);
      st.last = entry;
      prevOut = entry.out;
    }
    if (leftOut.length) this._logLeftOut(channel, leftOut);
    if (renumbered) {
      this.log.info(TAG, `ch ${channel}: the source renumbered its segments (${renumbered > 0 ? '+' : ''}${renumbered}) — players keep their numbering`);
    }

    const out = this._render(parsed, ids, st, body);
    this._prune(st, ids);
    if (out === 'stale') st.staleRun++;
    else st.staleRun = 0;
    if (out === null || out === 'stale') return st.lastBody ?? body;   // nothing new to show yet: keep the last playlist
    st.lastBody = out;
    return out;
  }

  // How much of `seg` repeats content up to the end of `prev` (seconds), when
  // that is enough to leave it out; null to keep it.
  //
  // The stream's own timestamps decide. Time-based names only say when to
  // look: one provider's servers name the same content up to 20 s apart (one
  // labels its files ahead of the clock), so a name-only judgement threw away
  // new content as "already played".
  async _repeat(prev, seg, url, time, channel) {
    const nameOverlap = time && prev.time ? prev.time.start + prev.time.dur - time.start : null;
    if (!seg.disc && !(nameOverlap >= OVERLAP_MIN_S)) return null;   // nothing suggests a repeat
    const prevDur = prev.dur ?? prev.time?.dur;
    const dur = seg.dur || time?.dur || prevDur;
    if (!prevDur || !dur) return null;
    const prevStart = await this._ptsOf(prev.url, channel);
    const curStart = await this._ptsOf(url, channel);
    if (prevStart === null || curStart === null) return null;        // can't confirm: keep
    const overlap = prevStart + prevDur - curStart;
    // Timestamps reset at restarts, so a start far before the previous one is
    // a repeat only when the names say the same thing; otherwise it is just a
    // reset clock.
    const farBack = curStart < prevStart - 1;
    if (farBack && !(nameOverlap !== null && Math.abs(nameOverlap - overlap) <= NAME_AGREE_S && overlap <= MAX_REPEAT_S)) return null;
    return overlap >= OVERLAP_MIN_S && overlap >= dur * OVERLAP_FRACTION ? Math.min(overlap, dur) : null;
  }

  _logLeftOut(channel, list) {
    const total = list.reduce((sum, l) => sum + l.repeat, 0);
    const what = list.length === 1 ? `segment ${list[0].seg.seq}` : `${list.length} segments (${list[0].seg.seq}–${list.at(-1).seg.seq})`;
    const when = list[0].time ? ` from ${clockOf(list[0].time.start)}` : '';
    this.log.info(TAG, `ch ${channel}: left out ${what}${when} after a source restart — ${total.toFixed(1)}s of content already played`);
  }

  // Forget what is far behind the window; never what it still lists.
  _prune(st, ids) {
    const listed = new Set(ids);
    const floor = (st.firstOut ?? st.last?.out ?? 0) - KEEP_HISTORY;
    for (const [id, e] of st.kept) if (e.out < floor && !listed.has(id) && e !== st.last) st.kept.delete(id);
    for (const [id, d] of st.dropped) if (d.seen < st.gen - RECENT_PLAYLISTS) st.dropped.delete(id);
  }

  // The playlist in our numbering: the kept segments of this window, in its
  // order, from the newest back to the first gap in our numbers (a kept
  // segment the source no longer lists — HLS numbers run without holes).
  // Tags that apply to what follows (EXT-X-MAP, EXT-X-KEY) on segments left
  // out or before the gap move to the next segment shown. It never starts
  // before the last playlist served did: an out-of-step server's older
  // playlist would make players go back. Null if nothing is kept; 'stale' if
  // all of it is older than what was served.
  _render(parsed, ids, st, body) {
    const rows = parsed.segments.map((seg, i) => ({ seg, e: st.kept.get(ids[i]) }));
    let end = rows.length - 1;
    while (end >= 0 && !rows[end].e) end--;
    if (end < 0) return null;
    let from = end;
    for (let j = end - 1, want = rows[end].e.out - 1; j >= 0; j--) {
      if (!rows[j].e) continue;
      if (rows[j].e.out !== want) break;
      from = j;
      want--;
    }
    if (st.firstOut !== null) {
      while (from <= end && (!rows[from].e || rows[from].e.out < st.firstOut)) from++;
      if (from > end) return 'stale';
    }
    const shown = (j) => j >= from && j <= end && rows[j].e;
    const first = rows[from].e;
    st.firstOut = first.out;

    // Untouched when it would come out the same.
    const same = from === 0 && end === rows.length - 1 && rows.every((r) => r.e) &&
      first.out === parsed.segments[0].seq &&
      first.dseq === discontinuitySequence(parsed) + (parsed.segments[0].disc ? 1 : 0) &&
      rows.every((r) => r.e.disc === r.seg.disc);
    if (same) return body;

    const header = parsed.header.filter((l) => !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))
      .flatMap((l) => (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')
        ? [`#EXT-X-MEDIA-SEQUENCE:${first.out}`, ...(first.dseq ? [`#EXT-X-DISCONTINUITY-SEQUENCE:${first.dseq}`] : [])]
        : [l]));
    const lines = [];
    let carry = new Map();   // tag name → latest line, from segments not shown
    for (let j = 0; j <= end; j++) {
      const { seg, e } = rows[j];
      const ownTags = seg.tags.filter((t) => t !== '#EXT-X-DISCONTINUITY');
      if (!shown(j)) {
        for (const t of ownTags) if (!OWN_TAGS.includes(tagName(t))) carry.set(tagName(t), t);
        continue;
      }
      // The first segment's discontinuity is counted in the header.
      if (e.disc && j > from) lines.push('#EXT-X-DISCONTINUITY');
      const names = new Set(ownTags.map(tagName));
      lines.push(...[...carry.values()].filter((t) => !names.has(tagName(t))), ...ownTags, seg.uri);
      carry = new Map();
    }
    return [...header, ...lines, ...parsed.trailer].join('\n') + '\n';
  }
}

module.exports = { RestartSmoother, parsePlaylist, timeFromName };
