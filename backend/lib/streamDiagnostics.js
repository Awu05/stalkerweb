'use strict';

// Live-stream diagnostics: what the proxy sees of each channel's HLS stream,
// logged so stutter, replays and audio/video drift can be traced to a cause.
//
// Per channel it watches, at the proxy:
//   • the media playlist — its sequence going backwards (players replay),
//     standing still, skipping ahead, discontinuities, slow reloads;
//   • each segment — download time against its playing time (slower than real
//     time starves the player), time to first byte, the same segment fetched
//     twice (a player re-requesting = replay);
//   • timestamps inside each segment (MPEG-TS PTS) — the source's clock
//     jumping back (replay at the source) or audio drifting from video.
//
// Problems are logged at warn as they happen; a one-line summary per channel
// is logged every SUMMARY_MS while the channel plays.

const log = require('../logger');
const TAG = 'stream-diag';

const SUMMARY_MS = 60_000;
const SLOW_RATIO = 0.8;          // download time / play time worth a warning
const SLOW_TTFB_S = 2;
const SLOW_PLAYLIST_S = 2;
const PTS_HZ = 90_000;
const PTS_JUMP_S = 2;            // timestamp change this far from expected = jump
const AV_DRIFT_S = 0.5;          // audio-video offset change worth a warning
const SCAN_BYTES = 64 * 1024;    // how much of a segment is scanned for timestamps

const pathOf = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } };
const s = (ms) => (ms / 1000).toFixed(1);

// First video and audio PTS (in seconds) in an MPEG-TS buffer, or null.
function firstTimestamps(buf) {
  let video = null;
  let audio = null;
  for (let i = 0; i + 188 <= buf.length && (video === null || audio === null); i += 188) {
    if (buf[i] !== 0x47) {           // resync to the next sync byte
      const next = buf.indexOf(0x47, i + 1);
      if (next < 0) break;
      i = next - 188;
      continue;
    }
    const pusi = (buf[i + 1] & 0x40) !== 0;
    const afc = (buf[i + 3] >> 4) & 0x3;
    if (!pusi || !(afc & 0x1)) continue;
    let p = i + 4;
    if (afc & 0x2) p += 1 + buf[p];
    if (p + 14 > i + 188) continue;
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
    const streamId = buf[p + 3];
    const isVideo = streamId >= 0xe0 && streamId <= 0xef;
    const isAudio = (streamId >= 0xc0 && streamId <= 0xdf) || streamId === 0xbd;
    if (!isVideo && !isAudio) continue;
    if (((buf[p + 7] >> 6) & 0x2) === 0) continue;   // no PTS
    const b = buf.subarray(p + 9, p + 14);
    const pts = ((b[0] >> 1) & 0x07) * 2 ** 30 + (((b[1] << 8) | b[2]) >> 1) * 2 ** 15 + (((b[3] << 8) | b[4]) >> 1);
    if (isVideo && video === null) video = pts / PTS_HZ;
    if (isAudio && audio === null) audio = pts / PTS_HZ;
  }
  return { video, audio };
}

class StreamDiagnostics {
  // onTimestamps(url, { video, audio }) receives each segment's start timestamps
  // (the restart smoother uses them instead of probing).
  constructor({ logger = log, now = () => Date.now(), onTimestamps = () => {} } = {}) {
    this.log = logger;
    this.now = now;
    this.onTimestamps = onTimestamps;
    this.channels = new Map();
  }

  _ch(id) {
    const key = String(id ?? 'unknown');
    let c = this.channels.get(key);
    if (!c) {
      c = {
        key, segs: new Map(),      // segment path → { seq, dur, fetches }
        left: new Set(),           // sequence numbers the restart smoother left out
        seqAt: null,               // { seq, at } — the playlist's sequence and when it was seen
        lastSeq: null, seqSince: 0, target: 6,
        lastSegSeq: null, lastPts: null,
        stats: { segments: 0, slow: 0, worstRatio: 0, ttfbSum: 0, ratioSum: 0, playlists: 0, playlistMax: 0, back: 0, repeats: 0, skips: 0, jumps: 0, drift: 0, discontinuities: 0 },
        timer: null,
      };
      this.channels.set(key, c);
    }
    this._arm(c);
    return c;
  }

  _arm(c) {
    if (c.timer) return;
    c.timer = setTimeout(() => { c.timer = null; this._summary(c); }, SUMMARY_MS);
    c.timer.unref?.();
  }

  _warn(c, msg) { this.log.warn(TAG, `ch ${c.key}: ${msg}`); }

  /** The restart smoother left segment `seq` out — players skip it on purpose. */
  leftOut(id, seq) { this._ch(id).left.add(seq); }

  _summary(c) {
    const st = c.stats;
    if (!st.segments && !st.playlists) { this.channels.delete(c.key); return; }
    const avg = (sum) => (st.segments ? sum / st.segments : 0);
    this.log.info(TAG,
      `ch ${c.key}: last ${SUMMARY_MS / 1000}s — ${st.segments} segments, download/play ${avg(st.ratioSum).toFixed(2)} avg ` +
      `${st.worstRatio.toFixed(2)} worst (${st.slow} slower than real time), first byte ${avg(st.ttfbSum).toFixed(2)}s avg, ` +
      `${st.playlists} playlist reloads (${s(st.playlistMax)}s worst), back ${st.back}, skipped ${st.skips}, repeated ${st.repeats}, ` +
      `discontinuities ${st.discontinuities}, timestamp jumps ${st.jumps}, a/v drift ${st.drift}`);
    c.stats = { segments: 0, slow: 0, worstRatio: 0, ttfbSum: 0, ratioSum: 0, playlists: 0, playlistMax: 0, back: 0, repeats: 0, skips: 0, jumps: 0, drift: 0, discontinuities: 0 };
  }

  /** A media (or master) playlist fetched for channel `id`. */
  playlist(id, url, body, fetchMs) {
    const c = this._ch(id);
    const seqMatch = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(body);
    if (!seqMatch) return;                              // master playlist
    const seq = Number(seqMatch[1]);
    const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(body)?.[1]) || c.target;
    c.target = target;
    c.stats.playlists++;
    c.stats.playlistMax = Math.max(c.stats.playlistMax, fetchMs);
    if (fetchMs > SLOW_PLAYLIST_S * 1000) this._warn(c, `playlist reload took ${s(fetchMs)}s (segments are ${target}s)`);

    const now = this.now();
    if (c.lastSeq !== null) {
      if (seq < c.lastSeq) {
        c.stats.back++;
        this._warn(c, `playlist went BACK from sequence ${c.lastSeq} to ${seq} — players replay what they already showed (out-of-step CDN servers?)`);
      } else if (seq === c.lastSeq && now - c.seqSince > 3 * target * 1000) {
        this._warn(c, `playlist stuck at sequence ${seq} for ${s(now - c.seqSince)}s — the source isn't producing new segments`);
        c.seqSince = now;
      }
    }
    if (c.lastSeq === null || seq !== c.lastSeq) c.seqSince = now;

    // The source producing segments much faster than real time (it does after
    // a restart on some servers): the live window races ahead and players
    // that can't keep their place jump forward.
    if (c.seqAt && seq > c.seqAt.seq) {
      const produced = seq - c.seqAt.seq;
      const elapsed = (now - c.seqAt.at) / 1000;
      if (produced >= 3 && produced * target > 2 * Math.max(elapsed, 1)) {
        const durs = [...body.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1]));
        const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : target;
        this._warn(c, `source moved ${produced} segments ahead in ${elapsed.toFixed(1)}s (segments about ${avg.toFixed(1)}s long) — faster than real time; players fall out of the window and jump`);
      }
    }
    c.seqAt = { seq, at: now };
    c.lastSeq = seq;

    // Map each segment to its sequence number and duration.
    let n = seq;
    let dur = null;
    let disc = false;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
      else if (line.startsWith('#EXT-X-DISCONTINUITY')) disc = true;
      else if (line && !line.startsWith('#')) {
        const key = pathOf(new URL(line, url).toString());
        if (!c.segs.has(key)) {
          c.segs.set(key, { seq: n, dur: dur ?? target, fetches: 0 });
          if (disc) { c.stats.discontinuities++; this._warn(c, `discontinuity before segment ${n} — the source restarted or switched; timestamps reset here`); }
        }
        n++;
        dur = null;
        disc = false;
      }
    }
    // Forget segments long gone from the playlist.
    if (c.segs.size > 200) {
      for (const [k, v] of c.segs) if (v.seq < seq - 50) c.segs.delete(k);
    }
  }

  /**
   * A segment request starting. Returns { firstByte(), data(chunk), done(bytes) }
   * to call as it streams.
   */
  segment(id, url) {
    const c = this._ch(id);
    const start = this.now();
    const info = c.segs.get(pathOf(url)) ?? { seq: null, dur: c.target, fetches: 0 };
    info.fetches++;
    if (info.fetches > 1) {
      c.stats.repeats++;
      this._warn(c, `segment ${info.seq ?? '?'} fetched again (${info.fetches}x) — the player re-requested it`);
    } else if (info.seq !== null && c.lastSegSeq !== null) {
      let missed = 0;
      for (let n = c.lastSegSeq + 1; n < info.seq; n++) if (!c.left.has(n)) missed++;
      if (missed > 0) {
        c.stats.skips++;
        this._warn(c, `player skipped from segment ${c.lastSegSeq} to ${info.seq} (${missed} missed) — it fell behind and jumped ahead`);
      } else if (info.seq < c.lastSegSeq) {
        c.stats.back++;
        this._warn(c, `player went back from segment ${c.lastSegSeq} to ${info.seq}`);
      }
    }
    if (info.seq !== null && info.fetches === 1) c.lastSegSeq = Math.max(c.lastSegSeq ?? info.seq, info.seq);

    let ttfb = null;
    let scanned = [];
    let scannedBytes = 0;
    return {
      firstByte: () => {
        ttfb = this.now() - start;
        if (ttfb > SLOW_TTFB_S * 1000) {
          this._warn(c, `segment ${info.seq ?? '?'}: waited ${s(ttfb)}s before the CDN started sending ` +
            `(a slow CDN, or queued behind another download on this stream's single connection)`);
        }
      },
      data: (chunk) => {
        if (scannedBytes >= SCAN_BYTES) return;
        scanned.push(chunk);
        scannedBytes += chunk.length;
      },
      done: (bytes) => {
        const ms = this.now() - start;
        const ratio = ms / 1000 / (info.dur || c.target);
        const st = c.stats;
        st.segments++;
        st.ratioSum += ratio;
        st.ttfbSum += (ttfb ?? ms) / 1000;
        st.worstRatio = Math.max(st.worstRatio, ratio);
        if (ratio > SLOW_RATIO) {
          st.slow++;
          this._warn(c, `segment ${info.seq ?? '?'}: ${(bytes / 1e6).toFixed(2)} MB took ${s(ms)}s for ${(info.dur || c.target).toFixed(1)}s of video — ` +
            `${ratio > 1 ? 'slower than real time, the player will run dry' : 'close to real time'}`);
        }
        if (info.fetches === 1 && scannedBytes) {
          const ts = firstTimestamps(Buffer.concat(scanned));
          this.onTimestamps(url, ts);
          this._timestamps(c, info, ts);
        }
        scanned = null;
      },
    };
  }

  _timestamps(c, info, { video, audio }) {
    const ref = video ?? audio;
    if (ref === null) return;
    const prev = c.lastPts;
    c.lastPts = { seq: info.seq, video, audio, dur: info.dur };
    if (!prev || info.seq === null || prev.seq === null || info.seq !== prev.seq + 1) return;
    const prevRef = video !== null ? prev.video : prev.audio;
    if (prevRef === null) return;
    const delta = ref - prevRef;
    const expected = prev.dur || c.target;
    if (Math.abs(delta - expected) > PTS_JUMP_S) {
      c.stats.jumps++;
      this._warn(c, `timestamps in segment ${info.seq} ${delta < 0 ? 'jumped BACK' : 'jumped'} ${Math.abs(delta - expected).toFixed(1)}s ` +
        `(expected +${expected.toFixed(1)}s, got ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}s) — the source's clock reset; players replay or skip here`);
    }
    if (video !== null && audio !== null && prev.video !== null && prev.audio !== null) {
      const drift = (audio - video) - (prev.audio - prev.video);
      if (Math.abs(drift) > AV_DRIFT_S) {
        c.stats.drift++;
        this._warn(c, `audio moved ${drift > 0 ? 'later' : 'earlier'} by ${Math.abs(drift).toFixed(2)}s relative to video in segment ${info.seq} — audio/video drift at the source`);
      }
    }
  }
}

module.exports = { StreamDiagnostics, firstTimestamps };
