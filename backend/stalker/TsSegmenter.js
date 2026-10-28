'use strict';

// Cuts a live channel's raw MPEG-TS into HLS pieces, for cast devices — what
// FFmpeg's `-c copy -f hls` did (see CastHls.js), in plain JavaScript, so it
// also works where there is no FFmpeg (the all-in-one Android app).
//
// It reads only what it needs: the PAT and PMT (which PIDs carry the video and
// audio, and their stream types), and the start of each video frame (its PTS,
// and whether it is a keyframe). A piece is closed at the first keyframe at
// least `targetSeconds` after it began, so every piece starts with one and
// plays on its own; each starts with the latest PAT and PMT, too. Packets are
// copied through untouched.
//
// When a stream has no keyframe marks at all (no random-access flag, no
// keyframe NAL we know), it is cut by the clock instead. A break — the caller
// says so with discontinuity(), or the PTS jumps by more than 10 s — closes
// the open piece and marks the next one with #EXT-X-DISCONTINUITY.
//
// No I/O here: the caller feeds the bytes and serves the playlist and pieces.

const PACKET = 188;
const SYNC = 0x47;
const PTS_HZ = 90000;
const WRAP = 2 ** 33;                    // PTS is 33 bits and wraps about every 26.5 hours
const JUMP_SECONDS = 10;                 // a PTS jump bigger than this is a break
const KEYLESS_TARGETS = 3;               // no keyframe for this many pieces' length: cut by the clock
const KEEP_EXTRA = 2;                    // pieces kept past the window, for players a little behind
const MAX_PIECE_BYTES = 32 * 1024 * 1024; // past this a piece is cut at the next frame, keyframe or not

const H264 = 0x1b;
const HEVC = 0x24;
const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, H264, HEVC, 0x42, 0xea]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
// A private stream (type 0x06) is audio when it has one of these descriptors: AC-3, E-AC-3, DTS.
const AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7b]);

const pidOf = (p) => ((p[1] & 0x1f) << 8) | p[2];
const startsUnit = (p) => (p[1] & 0x40) !== 0;

/** Seconds from PTS `b` to PTS `a`, across the wrap; negative when `a` is earlier. */
function ptsSeconds(a, b) {
  let d = (a - b) % WRAP;
  if (d < 0) d += WRAP;
  if (d >= WRAP / 2) d -= WRAP;
  return d / PTS_HZ;
}

/** A packet's payload (after any adaptation field), or null when it has none. */
function payloadOf(p) {
  const afc = (p[3] >> 4) & 3;
  if (!(afc & 1)) return null;
  const start = afc & 2 ? 5 + p[4] : 4;
  return start < PACKET ? p.subarray(start) : null;
}

/** The adaptation field's random_access_indicator. */
function randomAccess(p) {
  return ((p[3] >> 4) & 2) !== 0 && p[4] > 0 && (p[5] & 0x40) !== 0;
}

/** A PES header's PTS, or null. */
function pesPts(pes) {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || !(pes[7] & 0x80)) return null;
  return ((pes[9] >> 1) & 0x07) * 2 ** 30
    + pes[10] * 2 ** 22 + (pes[11] >> 1) * 2 ** 15
    + pes[12] * 2 ** 7 + (pes[13] >> 1);
}

/**
 * Whether the start of a frame holds a keyframe NAL: an H.264 IDR (type 5) or
 * an HEVC IRAP picture (types 16–21). Parameter sets don't count: some
 * encoders repeat them on every frame. (A keyframe whose NAL a long SEI pushes
 * past this first packet is still found by its random-access flag, which
 * most muxers set.)
 */
function hasKeyframeNal(es, videoType) {
  if (videoType !== H264 && videoType !== HEVC) return false;
  for (let i = 0; i + 3 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
    if (videoType === H264) {
      const t = es[i + 3] & 0x1f;
      if (t === 5) return true;
    } else {
      const t = (es[i + 3] >> 1) & 0x3f;
      if (t >= 16 && t <= 21) return true;
    }
  }
  return false;
}

/** The PSI section that starts in this packet (after the pointer field), or null. */
function sectionOf(p) {
  const payload = payloadOf(p);
  if (!payload || !startsUnit(p)) return null;
  const s = payload.subarray(1 + payload[0]);
  return s.length >= 3 ? s : null;
}

/** Where a section's body ends: its length, less the CRC, kept inside the packet. */
const sectionEnd = (s) => Math.min(3 + (((s[1] & 0x0f) << 8) | s[2]) - 4, s.length);

class TsSegmenter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.targetSeconds]  a piece's length (it ends at the first keyframe after this)
   * @param {number} [opts.windowSize]     pieces listed in the playlist
   * @param {() => number} [opts.now]      the clock, for a piece's length when its PTS can't give it
   * @param {number} [opts.maxPieceBytes]  a piece's size cap (tests make it small)
   */
  constructor({ targetSeconds = 4, windowSize = 10, now = Date.now, maxPieceBytes = MAX_PIECE_BYTES } = {}) {
    this.targetSeconds = targetSeconds;
    this.maxPieceBytes = maxPieceBytes;
    this.windowSize = windowSize;
    this.now = now;
    this.rest = Buffer.alloc(0);   // bytes of a packet not yet complete
    this.pat = null;               // the latest PAT's packets, put first in every piece
    this.pmt = null;               // and the latest PMT's
    this.pmtPid = null;
    this.videoPid = null;
    this.videoType = null;
    this.audioPid = null;
    this.audioType = null;
    this.lastPts = null;           // the latest frame's PTS, to spot a jump
    this.lastKeyPts = null;        // the latest keyframe's, to spot a stream without any
    this.frameStep = null;         // the shortest step between frames seen, in seconds
    this.at = 0;                   // when the bytes being read arrived
    this.waitFrom = null;          // with no piece open: the PTS we began waiting for a keyframe at
    this.open = null;              // { seq, packets, bytes, startPts, maxPts, startAt, lastAt, full, disc }
    this.pieces = [];              // closed, oldest first: { seq, data, dur, disc }
    this.seq = 0;
    this.pendingDisc = false;      // the next piece starts after a break
    this.discDropped = 0;          // discontinuities that went out of the kept pieces
  }

  /** Bytes of the stream, in any split. */
  push(chunk) {
    this.at = this.now();
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let i = 0;
    while (buf.length - i >= PACKET) {
      // Out of step (junk, or a lost byte): move on to the next sync byte that
      // is followed by another one a packet later.
      if (buf[i] !== SYNC || (i + PACKET < buf.length && buf[i + PACKET] !== SYNC)) { i++; continue; }
      this._packet(buf.subarray(i, i + PACKET));
      i += PACKET;
    }
    this.rest = Buffer.from(buf.subarray(i));
  }

  /** The source broke off (a reconnect): what comes next is a new piece, after a discontinuity. */
  discontinuity() {
    this._break();
  }

  /** The live media playlist, or null until the first piece is ready. */
  playlist() {
    if (!this.pieces.length) return null;
    const shown = this.pieces.slice(-this.windowSize);
    const hidden = this.pieces.length - shown.length;
    const dseq = this.discDropped + this.pieces.slice(0, hidden).filter((p) => p.disc).length;
    const extinf = (p) => p.dur.toFixed(3);
    const target = Math.max(1, ...shown.map((p) => Math.ceil(Number(extinf(p)))));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${shown[0].seq}`,
      ...(dseq ? [`#EXT-X-DISCONTINUITY-SEQUENCE:${dseq}`] : []),
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    for (const p of shown) {
      if (p.disc) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXTINF:${extinf(p)},`, `seg${p.seq}.ts`);
    }
    return lines.join('\n') + '\n';
  }

  /** A closed piece's bytes by its name (seg<seq>.ts), or null when it's unknown or gone. */
  segment(name) {
    const m = /^seg(\d+)\.ts$/.exec(name);
    if (!m) return null;
    const seq = Number(m[1]);
    return this.pieces.find((p) => p.seq === seq)?.data ?? null;
  }

  /** The PMT's stream types (null until known), to tell when a device can't play them. */
  get codecs() {
    return { videoType: this.videoType, audioType: this.audioType };
  }

  _packet(p) {
    const pid = pidOf(p);
    if (pid === 0) this._psi(p, 'pat');
    else if (pid === this.pmtPid) this._psi(p, 'pmt');
    else if (pid === this._clockPid() && startsUnit(p)) this._frameStart(p);
    if (!this.open) return;   // before the first cut point (or after a break): dropped
    this.open.packets.push(p);
    this.open.bytes += PACKET;
    this.open.lastAt = this.at;
    // Too big (a high bitrate with a long GOP): cut at the next frame. Twice
    // too big means no frame starts come at all, so it's dropped.
    if (this.open.bytes > this.maxPieceBytes) this.open.full = true;
    if (this.open.bytes > 2 * this.maxPieceBytes) {
      this.open = null;
      this.seq--;   // its number goes to the next piece, so the numbers stay in step with the media sequence
      this._afterBreak();
    }
  }

  // The stream whose frames set the pace: the video, or the audio when there's none.
  _clockPid() {
    return this.videoPid ?? this.audioPid;
  }

  /** Keeps a PAT or PMT (its packets, copied) and reads it. */
  _psi(p, kind) {
    if (startsUnit(p)) this[kind] = [Buffer.from(p)];
    else if (this[kind] && this[kind].length < 4) { this[kind].push(Buffer.from(p)); return; }
    else return;
    const s = sectionOf(p);
    if (!s) return;
    if (kind === 'pat') this._readPat(s);
    else this._readPmt(s);
  }

  _readPat(s) {
    if (s[0] !== 0x00) return;
    const end = sectionEnd(s);
    for (let i = 8; i + 4 <= end; i += 4) {
      const program = (s[i] << 8) | s[i + 1];
      if (program === 0) continue;   // the network PID, not a program
      const pid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
      if (pid !== this.pmtPid) { this.pmtPid = pid; this.pmt = null; }
      return;
    }
  }

  // The first video stream and the first audio stream, with their types.
  _readPmt(s) {
    if (s[0] !== 0x02 || s.length < 12) return;
    const end = sectionEnd(s);
    let video = null, audio = null;
    for (let i = 12 + (((s[10] & 0x0f) << 8) | s[11]); i + 5 <= end;) {
      const type = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const infoLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      if (!video && VIDEO_TYPES.has(type)) video = { pid, type };
      else if (!audio && (AUDIO_TYPES.has(type) || (type === 0x06 && hasAudioDescriptor(s.subarray(i + 5, i + 5 + infoLen))))) audio = { pid, type };
      i += 5 + infoLen;
    }
    this.videoPid = video?.pid ?? null;
    this.videoType = video?.type ?? null;
    this.audioPid = audio?.pid ?? null;
    this.audioType = audio?.type ?? null;
  }

  /** A frame starts on the clock PID: maybe a break, maybe a cut point. */
  _frameStart(p) {
    const payload = payloadOf(p);
    const pts = payload && pesPts(payload);
    if (pts == null) return;
    if (this.lastPts !== null) {
      const step = ptsSeconds(pts, this.lastPts);
      if (Math.abs(step) > JUMP_SECONDS) this._break();
      else if (step > 0 && step <= 1 && (this.frameStep === null || step < this.frameStep)) this.frameStep = step;
    }
    this.lastPts = pts;

    const key = pidOf(p) === this.videoPid
      && (randomAccess(p) || hasKeyframeNal(payload.subarray(9 + payload[8]), this.videoType));
    if (key) this.lastKeyPts = pts;

    let due;
    if (this.open) {
      due = this.open.full
        || (ptsSeconds(pts, this.open.startPts) >= this.targetSeconds && (key || this._keyless(pts)));
    } else {
      // Wait for a keyframe to start on, but not longer than a piece's length.
      if (this.waitFrom === null) this.waitFrom = pts;
      due = key || ptsSeconds(pts, this.waitFrom) >= this.targetSeconds;
    }
    if (!due) {
      if (this.open && ptsSeconds(pts, this.open.maxPts) > 0) this.open.maxPts = pts;
      return;
    }
    if (this.open) this._close(ptsSeconds(pts, this.open.startPts));
    this._openPiece(pts);
  }

  // No keyframe seen yet, or none for a while: the stream has no marks we can read.
  _keyless(pts) {
    return this.lastKeyPts === null || ptsSeconds(pts, this.lastKeyPts) > KEYLESS_TARGETS * this.targetSeconds;
  }

  /**
   * The stream broke off. The open piece is closed; with no next piece on its
   * timeline to measure to, its length is the time its frames cover (first to
   * last, plus one frame). With one frame and no frame rate known yet, it's
   * the arrival time of its packets, first to last. Never the time to the
   * break: a stall before it would make the piece far too long.
   */
  _break() {
    const o = this.open;
    if (o) {
      const frames = ptsSeconds(o.maxPts, o.startPts) + (this.frameStep || 0);
      const arrival = (o.lastAt - o.startAt) / 1000;
      this._close(frames > 0 ? frames : Math.max(arrival, 0.001));
    }
    this._afterBreak();
  }

  // Timestamps before a break mean nothing after it.
  _afterBreak() {
    if (this.pieces.length) this.pendingDisc = true;
    this.lastPts = null;
    this.lastKeyPts = null;
    this.waitFrom = null;
  }

  _openPiece(pts) {
    const head = [...(this.pat || []), ...(this.pmt || [])];
    this.open = {
      seq: this.seq++, packets: head, bytes: head.length * PACKET,
      startPts: pts, maxPts: pts, startAt: this.at, lastAt: this.at, full: false, disc: this.pendingDisc,
    };
    this.pendingDisc = false;
    this.waitFrom = null;
  }

  _close(dur) {
    const o = this.open;
    this.open = null;
    this.pieces.push({ seq: o.seq, data: Buffer.concat(o.packets), dur, disc: o.disc });
    while (this.pieces.length > this.windowSize + KEEP_EXTRA) {
      if (this.pieces.shift().disc) this.discDropped++;
    }
  }
}

function hasAudioDescriptor(d) {
  for (let j = 0; j + 2 <= d.length; j += 2 + d[j + 1]) {
    if (AUDIO_DESCRIPTORS.has(d[j])) return true;
  }
  return false;
}

module.exports = { TsSegmenter };
