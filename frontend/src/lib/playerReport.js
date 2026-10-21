// A playback error, sent to the server log (POST /api/stream/report) — on a
// phone the reason a stream fails otherwise stays in a console no one can open.
// Fire and forget; the same report twice within 10 s is sent once.

const recent = new Map()

/** { channelId?, title?, engine, kind, detail?, attempt?, gaveUp? } */
export function reportPlayerError(report) {
  try {
    const key = JSON.stringify([report.channelId, report.title, report.engine, report.kind, report.detail, report.gaveUp])
    const now = Date.now()
    if (now - (recent.get(key) ?? 0) < 10_000) return
    recent.set(key, now)
    if (recent.size > 50) recent.delete(recent.keys().next().value)
    fetch('/api/stream/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {})
  } catch { /* a report is never worth breaking playback over */ }
}

const MEDIA_ERRORS = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'format not supported' }

/** A <video>'s own error, as words: "MediaError 3 (decode): PIPELINE_ERROR_DECODE". */
export function mediaErrorText(video) {
  const e = video?.error
  if (!e) return null
  return `MediaError ${e.code} (${MEDIA_ERRORS[e.code] || 'unknown'})${e.message ? `: ${e.message}` : ''}`
}

/** hls.js's fatal error, as words: kind "mediaError", detail "bufferAppendError: …". */
export function hlsErrorText(data) {
  const parts = [data?.details]
  if (data?.response?.code) parts.push(`HTTP ${data.response.code}`)
  const msg = data?.error?.message || data?.reason
  if (msg) parts.push(msg)
  if (data?.mimeType) parts.push(data.mimeType)
  return { kind: String(data?.type || 'error'), detail: parts.filter(Boolean).join(': ') }
}
