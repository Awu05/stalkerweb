// FfmpegService.js
// Server-side remux/transcode for UDP, RTP, and RTSP streams that browsers
// cannot fetch natively.
//
// Strategy:
//   1. ffprobe the source to identify video/audio codecs.
//   2. If both are already browser-safe (H.264 + AAC/MP3/Opus/PCM) use
//      -c copy — pure remux, negligible CPU.
//   3. Otherwise re-encode: video → libx264, audio → aac.
//   4. Output format is always mpegts piped to stdout so mpegts.js can play it.

'use strict';

const { spawn, spawnSync } = require('child_process');
const log = require('../logger');
const TAG = 'ffmpeg';

// ── Availability check (cached) ───────────────────────────────────────────────

let _available = null;

function isAvailable() {
  if (_available !== null) return _available;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5_000, stdio: 'pipe' });
    _available = r.status === 0;
  } catch {
    _available = false;
  }
  if (_available) log.info(TAG, 'FFmpeg found — UDP/RTP/RTSP remux enabled');
  else            log.warn(TAG, 'FFmpeg not found — UDP/RTP/RTSP channels unavailable');
  return _available;
}

// ── Browser-playable codec sets (mpegts.js path) ──────────────────────────────
// The web player pulls raw MPEG-TS through mpegts.js, which plays H.264 and
// H.265 video with AAC/MP3 audio. MPEG-2 video and AC-3/E-AC-3/MP2 audio play
// in STBemu/VLC (native FFmpeg) but not in a browser: for a browser those are
// transcoded (routes/proxy.js). HEVC is passed through, as it always has been —
// browsers that decode it (Chrome with hardware, Safari) play it, and
// re-encoding a 4K channel would cost far more than it saves; one a browser
// can't decode reports a decode failure (lib/playerReport.js).
const COPY_VIDEO = new Set(['h264', 'hevc']);
const COPY_AUDIO = new Set(['aac', 'mp3']);

// True when mpegts.js can play the raw stream as-is (no server-side ffmpeg).
// A null probe means "unknown" — return true so we never regress a channel that
// plays fine today by needlessly forcing it through ffmpeg.
function browserDirectPlayable(probe) {
  if (!probe) return true;
  const vOk = !probe.video || COPY_VIDEO.has(probe.video);
  const aOk = !probe.audio || COPY_AUDIO.has(probe.audio);
  return vOk && aOk;
}

// Map an ffprobe format_name (comma-separated list) to one of stalkerweb's
// player engine types, or null if unrecognised. Lets us classify an
// extensionless link by what it actually IS, the way stalkerhek keys off the
// Content-Type header rather than the URL extension.
function _containerFromFormat(formatName) {
  if (!formatName) return null;
  const names = formatName.toLowerCase().split(',');
  if (names.some(n => n === 'hls' || n === 'applehttp')) return 'hls';
  // FLV too: mpegts.js plays it (a plain <video> can't).
  if (names.includes('mpegts') || names.includes('flv')) return 'mpegts';
  if (names.some(n => ['mov', 'mp4', 'matroska', 'webm', 'm4a'].includes(n))) return 'native';
  return null;
}

// ── ffprobe codec probe ───────────────────────────────────────────────────────
// Returns { video: 'h264'|null, audio: 'aac'|null } or null on error.
// `headers` (optional) are the portal auth headers — required for tokenized
// portal/CDN stream URLs, or ffprobe gets a 403 and we'd misjudge the codecs.
// Results are cached per stream since the codec is a property of the channel,
// not of its per-play token (probeCacheKey). Only results that read something:
// a probe that read nothing is tried again next time.
const _probeCache = new Map();   // probeCacheKey → { probe, ts }
const PROBE_TTL_MS = 60 * 60 * 1000;

// Query parameters that change with every play (tokens, signatures, expiries) —
// left out of the cache key. The rest stays: on a portal's play/live.php?…
// every channel shares the path and only `stream=` tells them apart.
const VOLATILE_PARAM = /^(play_?token|token|sig|signature|expires?|exp|ts|hash|auth|key|session|sid|e|st)$/i;

/** The cache key for a stream link: the link without its per-play parameters. */
function probeCacheKey(streamUrl) {
  try {
    const u = new URL(streamUrl);
    const kept = [...u.searchParams.entries()].filter(([k]) => !VOLATILE_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
    return `${u.origin}${u.pathname}${kept.length ? `?${new URLSearchParams(kept)}` : ''}`;
  } catch {
    return String(streamUrl);
  }
}

// ffprobe's reason for reading nothing: its error line, not decoder chatter
// from stream detection (which also comes out at -v error).
const PROBE_NOISE = /\[(h264|hevc|mpeg2video|aac|ac3|mp3|eac3)[^\]]*\]|non-existing (PPS|SPS)|decode_slice_header|no frame!|missing picture/i;
function probeFailureReason(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => !PROBE_NOISE.test(l)).pop() || lines.pop() || null;
}

async function probeCodecs(streamUrl, headers = null) {
  const cacheKey = probeCacheKey(streamUrl);
  const hit = _probeCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < PROBE_TTL_MS) return hit.probe;

  const inputArgs = _inputArgs(streamUrl, headers);
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      ...inputArgs,
      '-i', streamUrl,
      '-v', 'error',                  // errors on stderr: said when nothing could be read
      '-print_format', 'json',
      '-show_format',                 // format_name → container (hls/mpegts/mp4…)
      '-show_streams',                // all of them: the first video and audio are picked below
      // (No -select_streams: "a:0,v:0" isn't a stream specifier ffprobe takes —
      // it refused every probe this way, so nothing was ever read.)
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let errOut = '';
    probe.stdout.on('data', d => { out += d.toString(); });
    probe.stderr.on('data', d => { if (errOut.length < 4000) errOut += d.toString(); });

    const finish = (result) => {
      // A probe that read nothing (a stalled source, a stale token) isn't kept.
      if (result && (result.video || result.audio)) _probeCache.set(cacheKey, { probe: result, ts: Date.now() });
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { probe.kill('SIGKILL'); } catch {}
      log.warn(TAG, `ffprobe timed out for ${streamUrl} — codecs unknown`);
      finish(null);
    }, 12_000);

    probe.on('close', () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out);
        let video = null, audio = null, vs = null, as = null;
        for (const s of json.streams || []) {
          if (s.codec_type === 'video' && !video) { video = (s.codec_name || '').toLowerCase(); vs = s; }
          if (s.codec_type === 'audio' && !audio) { audio = (s.codec_name || '').toLowerCase(); as = s; }
        }
        const container = _containerFromFormat(json.format?.format_name);
        const direct = browserDirectPlayable({ video, audio });
        // Nothing read: why, from ffprobe itself (its last error line).
        const why = !vs && !as ? probeFailureReason(errOut) : null;
        const describe = describeStreams(vs, as, container) + (why ? ` — ffprobe: ${why}` : '');
        log.info(TAG, `probe: ${describe} browser-direct=${direct}`);
        finish({ video, audio, container, describe });
      } catch {
        log.warn(TAG, 'ffprobe output parse failed — codecs unknown');
        finish(null);
      }
    });

    probe.on('error', (err) => {
      clearTimeout(timer);
      log.warn(TAG, `ffprobe error: ${err.message} — codecs unknown`);
      finish(null);
    });
  });
}

/**
 * A stream's format in a line — what decides whether a device can play it:
 * "video hevc Main 10 (hev1) 3840x2160 yuv420p10le progressive 50fps, audio aac 2ch 48000Hz, in hls".
 */
function describeStreams(v, a, container) {
  const parts = [];
  if (v) {
    const tag = v.codec_tag_string && !/^\[/.test(v.codec_tag_string) ? ` (${v.codec_tag_string})` : '';
    const fps = /^(\d+)\/(\d+)$/.exec(v.avg_frame_rate || '');
    const rate = fps && Number(fps[2]) ? ` ${Math.round(Number(fps[1]) / Number(fps[2]))}fps` : '';
    parts.push(`video ${v.codec_name || '?'}${v.profile ? ` ${v.profile}` : ''}${tag} ${v.width || '?'}x${v.height || '?'} ${v.pix_fmt || '?'}${v.field_order ? ` ${v.field_order}` : ''}${rate}`);
  } else parts.push('no video');
  if (a) parts.push(`audio ${a.codec_name || '?'}${a.channels ? ` ${a.channels}ch` : ''}${a.sample_rate ? ` ${a.sample_rate}Hz` : ''}`);
  else parts.push('no audio');
  return `${parts.join(', ')}, in ${container || '?'}`;
}

// ── Input args for each protocol ─────────────────────────────────────────────

function _inputArgs(url, headers = null) {
  const lower = url.toLowerCase();
  if (lower.startsWith('rtsp://')) {
    // TCP avoids UDP packet loss on RTSP; more reliable over NAT
    return ['-rtsp_transport', 'tcp'];
  }
  if (lower.startsWith('udp://') || lower.startsWith('rtp://') ||
      lower.startsWith('igmp://') || lower.startsWith('mc://')) {
    // Give ffmpeg time to receive the multicast/unicast burst before giving up.
    // Value is in microseconds (10 s).
    return ['-timeout', '10000000'];
  }
  // http(s): tokenized portal/CDN links need the same auth headers the proxy
  // sends, or ffmpeg/ffprobe gets a 403. Auto-reconnect keeps a long live pull
  // alive across transient CDN drops/keep-alive closes instead of EOF-ing the
  // pipe (which would stall the browser player).
  return [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ..._httpHeaderArgs(headers),
  ];
}

// Translate a header map into ffmpeg input options. The User-Agent gets its own
// dedicated flag; everything else goes into -headers as a CRLF-joined blob.
function _httpHeaderArgs(headers) {
  if (!headers) return [];
  const args = [];
  const ua = headers['User-Agent'] || headers['user-agent'];
  if (ua) args.push('-user_agent', ua);
  const rest = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  if (rest) args.push('-headers', rest + '\r\n');
  return args;
}

// ── Codec args: per-stream copy vs re-encode ──────────────────────────────────
// Decided independently for video and audio so the common "H.264 video + AC-3
// audio" case only re-encodes the audio (cheap) and copies the video untouched.
// A null probe means codecs are unknown → re-encode both as a safe fallback.
function _codecArgs(probe) {
  const args = [];
  if (!probe || (probe.video && !COPY_VIDEO.has(probe.video))) {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
  } else {
    args.push('-c:v', 'copy');
  }
  if (!probe || (probe.audio && !COPY_AUDIO.has(probe.audio))) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-c:a', 'copy');
  }
  return args;
}

// ── Args for remuxing a stream (e.g. HLS) straight to a local file ──────────
// Used by the download queue to save VOD titles that only expose an .m3u8
// playlist — no browser can save that as a single file, but ffmpeg can remux
// the segments into one .mp4 without re-encoding (cheap, near-instant per byte).
// `probe` (optional, from probeCodecs) decides whether the ADTS→ASC bitstream
// filter is needed; it only applies when the audio is actually AAC.
function buildDownloadArgs(streamUrl, headers, outPath, probe = null) {
  const inputArgs = _inputArgs(streamUrl, headers);
  // The first video and audio — the ones the probe described (FFmpeg's own pick
  // is the audio with the most channels, which may not be the probed AAC).
  const args = ['-hide_banner', '-loglevel', 'warning', '-y', ...inputArgs, '-i', streamUrl, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
  if (!probe || probe.audio === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  // outPath is a ".mp4.part" staging file — force the muxer explicitly since
  // ffmpeg would otherwise guess it from the (unrecognized) ".part" extension.
  args.push('-f', 'mp4', outPath);
  return args;
}

// ── Main transcode entry point ────────────────────────────────────────────────
// Probes the source, chooses copy vs re-encode, spawns FFmpeg, pipes to res.
// Returns a Promise that resolves when the FFmpeg process has started (or rejects
// on immediate failure — e.g. spawn error).

async function transcode(streamUrl, req, res, headers = null) {
  // Probe first so we pick the right codec args
  const probe = await probeCodecs(streamUrl, headers);

  const inputArgs  = _inputArgs(streamUrl, headers);
  const codecArgs  = _codecArgs(probe);
  const outputArgs = ['-f', 'mpegts', 'pipe:1'];
  const mode = codecArgs.includes('libx264') ? 're-encode' : 'copy';

  // The first video and audio, as probed (see buildDownloadArgs).
  const args = ['-hide_banner', '-loglevel', 'warning', ...inputArgs, '-i', streamUrl, '-map', '0:v:0?', '-map', '0:a:0?', ...codecArgs, ...outputArgs];
  log.info(TAG, `spawning FFmpeg [${mode}]: ffmpeg ${args.join(' ')}`);

  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Stream the raw MPEG-TS bytes to the browser
  res.set('Content-Type', 'video/MP2T');
  res.set('Cache-Control', 'no-cache, no-store');
  res.set('Access-Control-Allow-Origin', '*');

  ffmpeg.stdout.pipe(res);

  // ── Lifecycle management ─────────────────────────────────────────────────
  let killed = false;
  function kill(reason) {
    if (killed) return;
    killed = true;
    log.debug(TAG, `terminating FFmpeg process (${reason})`);
    try { ffmpeg.kill('SIGKILL'); } catch {}
  }

  // Kill immediately when the viewer closes the tab/navigates away
  req.on('close', () => kill('client disconnected'));

  ffmpeg.on('error', (err) => {
    log.error(TAG, `process error: ${err.message}`);
    kill('process error');
    if (!res.headersSent) {
      res.status(502).send(`FFmpeg error: ${err.message}`);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });

  ffmpeg.on('close', (code, signal) => {
    if (!killed && code !== 0) {
      log.warn(TAG, `FFmpeg exited with code=${code} signal=${signal}`);
    }
    if (!res.writableEnded) res.end();
  });

  // Log FFmpeg stderr at debug level (it's verbose but useful for debugging).
  // Suppress the repeated "Last message repeated N times" lines.
  let stderrBuf = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const t = line.trim();
      if (t && !t.startsWith('Last message repeated')) log.debug(TAG, t);
    }
  });
}

module.exports = { isAvailable, transcode, probeCodecs, browserDirectPlayable, buildDownloadArgs, describeStreams, probeCacheKey, probeFailureReason, _containerFromFormat };
