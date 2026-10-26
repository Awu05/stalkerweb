import { rangesOf } from './stallRecovery'

/**
 * The player's Stats panel (components/StreamStats.jsx): what's playing and
 * how it's getting here. The apps' StreamStats.kt says the same things.
 */

const CODECS = [
  [/^(avc[13]|h264)/i, 'H.264'],
  [/^(hvc1|hev1|hevc|h265)/i, 'H.265'],
  [/^(vp09|vp9)/i, 'VP9'],
  [/^av01/i, 'AV1'],
  [/^(mp4a\.40\.34|mp4a\.6b|mp3)/i, 'MP3'],
  [/^(mp4a|aac)/i, 'AAC'],
  [/^(ac-3|ac3)/i, 'AC-3'],
  [/^(ec-3|eac3)/i, 'E-AC-3'],
  [/^opus/i, 'Opus'],
]

/** "avc1.64001f" → "H.264", "mp4a.40.2" → "AAC"; an unknown codec as it is. */
export function codecLabel(codec) {
  const c = String(codec || '').trim()
  if (!c) return ''
  return CODECS.find(([re]) => re.test(c))?.[1] ?? c
}

/** 640000 → "640 kb/s", 4250000 → "4.3 Mb/s"; nothing known → "—". */
export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  return bps < 1_000_000 ? `${Math.round(bps / 1000)} kb/s` : `${(bps / 1_000_000).toFixed(1)} Mb/s`
}

/** Seconds buffered ahead of `t` (a <video>'s buffered ranges). */
export function bufferAhead(buffered, t) {
  const range = rangesOf(buffered).find(([start, end]) => t >= start && t <= end)
  return range ? range[1] - t : 0
}

/** The server's delivery (GET /api/activity/delivery), in words. */
export function deliveryText(d) {
  if (!d) return '—'
  const more = d.detail ? ` (${d.detail})` : ''
  switch (d.mode) {
    case 'direct':     return 'Straight from the provider'
    case 'relayed':    return `Relayed by the server${more}`
    case 'repackaged': return 'Repackaged by the server (no quality loss)'
    case 'converted':  return `Converted by the server${more}`
    default:           return '—'
  }
}

// What hls.js found in what it plays, for a playlist that doesn't say (a plain
// media playlist names no CODECS or BANDWIDTH): its codecs, and the bitrate
// of the last segment loaded.
const hlsFound = new WeakMap()

/** Watch an hls.js player for sampleEngine. `Events` is Hls.Events. */
export function trackHlsStats(hls, Events) {
  const found = {}
  hlsFound.set(hls, found)
  hls.on(Events.BUFFER_CODECS, (_e, data) => {
    found.video = data?.video?.codec || data?.audiovideo?.codec || found.video
    found.audio = data?.audio?.codec || found.audio
  })
  hls.on(Events.FRAG_LOADED, (_e, data) => {
    const frag = data?.frag
    const bytes = frag?.stats?.loaded
    if (frag?.type === 'main' && bytes > 0 && frag.duration > 0) found.bitrate = (bytes * 8) / frag.duration
  })
}

/**
 * What the playback engine knows: codecs, the stream's bitrate and the
 * download speed (bits/s). hls.js and mpegts.js say; the browser's own player doesn't.
 */
export function sampleEngine({ hls, mpegts } = {}) {
  if (hls) {
    const level = hls.levels?.[hls.currentLevel] ?? {}
    const found = hlsFound.get(hls) ?? {}
    return {
      video: codecLabel(level.videoCodec || found.video),
      audio: codecLabel(level.audioCodec || found.audio),
      bitrate: level.bitrate || found.bitrate || null,
      download: hls.bandwidthEstimate || null,
    }
  }
  if (mpegts) {
    const info = mpegts.mediaInfo ?? {}
    const kbps = (info.videoDataRate || 0) + (info.audioDataRate || 0)
    const speed = mpegts.statisticsInfo?.speed   // KB/s
    return {
      video: codecLabel(info.videoCodec),
      audio: codecLabel(info.audioCodec),
      bitrate: kbps > 0 ? kbps * 1000 : null,
      download: speed > 0 ? speed * 1024 * 8 : null,
    }
  }
  return { video: '', audio: '', bitrate: null, download: null }
}
