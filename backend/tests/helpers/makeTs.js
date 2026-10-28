// Synthetic MPEG-TS for the segmenter tests: a PAT, a PMT, a video PES per
// frame (with its PTS, a keyframe every `keyEvery` seconds) and an audio PES
// per frame. No real pictures or sound — only the bytes a segmenter reads.

export const PAT_PID = 0
export const PMT_PID = 0x1000
export const VIDEO_PID = 0x100
export const AUDIO_PID = 0x101

const PTS_HZ = 90000

/** The PID of the packet at `offset`. */
export const pidOf = (buf, offset) => ((buf[offset + 1] & 0x1f) << 8) | buf[offset + 2]

// Bits `shift` and up of a number that may not fit in 32 bits (PTS and PCR are 33).
const byteAt = (v, shift) => Math.floor(v / 2 ** shift) & 0xff

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
  }
  return c >>> 0
}

/** One 188-byte packet; the adaptation field carries `af` and any stuffing. */
function packet(pid, pusi, cc, af, payload) {
  const afTotal = 184 - payload.length   // bytes left for the adaptation field
  const head = [0x47, (pusi ? 0x40 : 0) | (pid >> 8), pid & 0xff, (afTotal ? 0x30 : 0x10) | cc]
  let field = []
  if (afTotal === 1) field = [0]
  else if (afTotal > 1) {
    const body = af.length ? af : [0x00]
    field = [afTotal - 1, ...body, ...new Array(afTotal - 1 - body.length).fill(0xff)]
  }
  return Buffer.from([...head, ...field, ...payload])
}

/** Splits `bytes` into packets on `pid`; the first starts the unit and carries `af`. */
function packetize(pid, bytes, af, counters) {
  const out = []
  let i = 0
  do {
    const first = i === 0
    const extra = first && af.length ? af : []
    const avail = 184 - (extra.length ? 1 + extra.length : 0)
    const take = Math.min(avail, bytes.length - i)
    const cc = counters[pid] = ((counters[pid] ?? -1) + 1) & 0x0f
    out.push(packet(pid, first, cc, extra, bytes.slice(i, i + take)))
    i += take
  } while (i < bytes.length)
  return out
}

function section(tableId, rest) {
  const len = rest.length + 4
  const s = [tableId, 0xb0 | (len >> 8), len & 0xff, ...rest]
  const crc = crc32(s)
  return [0x00, ...s, crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]   // pointer_field first
}

function pat() {
  return section(0x00, [0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff])
}

function pmt({ pcrPid, video, audio }) {
  const es = (type, pid) => [type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00]
  return section(0x02, [
    0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe0 | (pcrPid >> 8), pcrPid & 0xff, 0xf0, 0x00,
    ...(video != null ? es(video, VIDEO_PID) : []),
    ...(audio != null ? es(audio, AUDIO_PID) : []),
  ])
}

function ptsBytes(pts) {
  const low = pts % 2 ** 30
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
    (low >> 22) & 0xff, ((low >> 14) & 0xfe) | 1,
    (low >> 7) & 0xff, ((low << 1) & 0xfe) | 1,
  ]
}

function pcrBytes(base) {
  return [byteAt(base, 25), byteAt(base, 17), byteAt(base, 9), byteAt(base, 1), ((base % 2) << 7) | 0x7e, 0x00]
}

function pes(streamId, pts, es, bounded) {
  const len = bounded ? es.length + 8 : 0
  return [0x00, 0x00, 0x01, streamId, len >> 8, len & 0xff, 0x80, 0x80, 0x05, ...ptsBytes(pts), ...es]
}

// A frame's elementary stream: an access unit delimiter, then a slice that is
// a keyframe (IDR, HEVC IDR_W_RADL) or not. With mark 'rai' a keyframe's slice
// stays ordinary, so only the random-access flag marks it. `sps` puts parameter
// sets (H.264 SPS + PPS, HEVC VPS + SPS) before the slice, as some encoders do
// on every frame.
function frame(video, key, sps, filler) {
  if (video === 0x1b) return [0, 0, 0, 1, 0x09, 0xf0, ...(sps ? [0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0xce] : []), 0, 0, 1, key ? 0x65 : 0x41, ...filler]
  if (video === 0x24) return [0, 0, 0, 1, 0x46, 0x01, 0x50, ...(sps ? [0, 0, 1, 0x40, 0x01, 0, 0, 1, 0x42, 0x01] : []), 0, 0, 1, key ? 0x26 : 0x02, 0x01, ...filler]
  return [0, 0, 1, 0x00, ...filler]   // MPEG-2 and others: a picture start, nothing a segmenter reads
}

/**
 * @param {object} o
 * @param {number} o.seconds        stream length
 * @param {number} [o.fps]
 * @param {number} [o.keyEvery]     seconds between keyframes; 0 = no keyframe marks at all
 * @param {number} [o.pcrPid]
 * @param {number|null} [o.video]   PMT stream type (0x1b H.264, 0x24 HEVC, 0x02 MPEG-2)
 * @param {number|null} [o.audio]   PMT stream type, null for none
 * @param {number} [o.startPts]     the first frame's PTS (90 kHz)
 * @param {'nal'|'rai'} [o.mark]    how keyframes are marked: a keyframe NAL, or the random-access flag
 * @param {boolean} [o.spsEvery]    parameter sets before every frame, keyframe or not
 * @param {number} [o.frameBytes]   filler per video frame (a bigger frame, a higher bitrate)
 */
export function makeTs({ seconds, fps = 25, keyEvery = 2, pcrPid = VIDEO_PID, video = 0x1b, audio = 0x0f, startPts = 0, mark = 'nal', spsEvery = false, frameBytes = 400 }) {
  const counters = {}
  const filler = new Array(frameBytes).fill(0x55)
  const out = []
  const step = PTS_HZ / fps
  for (let i = 0; i < seconds * fps; i++) {
    const pts = startPts + i * step
    if (i % fps === 0) {
      out.push(...packetize(PAT_PID, pat(), [], counters))
      out.push(...packetize(PMT_PID, pmt({ pcrPid, video, audio }), [], counters))
    }
    const key = keyEvery > 0 && i % (keyEvery * fps) === 0
    if (video != null) {
      const af = []
      if (pcrPid === VIDEO_PID) af.push(0x10, ...pcrBytes(pts))
      if (key && mark === 'rai') { if (af.length) af[0] |= 0x40; else af.push(0x40) }
      out.push(...packetize(VIDEO_PID, pes(0xe0, pts, frame(video, key && mark === 'nal', spsEvery, filler), false), af, counters))
    }
    if (audio != null) {
      const af = pcrPid === AUDIO_PID ? [0x10, ...pcrBytes(pts)] : []
      out.push(...packetize(AUDIO_PID, pes(0xc0, pts, new Array(64).fill(0x55), true), af, counters))
    }
  }
  return Buffer.concat(out)
}

/**
 * Whether the first video frame in `buf` is a keyframe: its random-access flag
 * is set, or its payload holds an H.264 IDR (type 5) or HEVC IRAP (16–21) NAL.
 */
export function startsWithKeyframe(buf) {
  for (let o = 0; o + 188 <= buf.length; o += 188) {
    if (pidOf(buf, o) !== VIDEO_PID || !(buf[o + 1] & 0x40)) continue
    const afc = (buf[o + 3] >> 4) & 3
    if (afc & 2 && buf[o + 4] > 0 && buf[o + 5] & 0x40) return true
    const p = buf.subarray(o + 4 + (afc & 2 ? 1 + buf[o + 4] : 0), o + 188)
    for (let i = 0; i + 3 < p.length; i++) {
      if (p[i] !== 0 || p[i + 1] !== 0 || p[i + 2] !== 1) continue
      const h264 = p[i + 3] & 0x1f
      const hevc = (p[i + 3] >> 1) & 0x3f
      if (h264 === 5 || (hevc >= 16 && hevc <= 21)) return true
    }
    return false
  }
  return false
}
