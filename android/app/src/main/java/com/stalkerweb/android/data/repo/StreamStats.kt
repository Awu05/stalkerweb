package com.stalkerweb.android.data.repo

import java.util.Locale

// The player's Stats panel (ui/components/StreamStatsOverlay.kt), in the words
// the web's lib/streamStats.js uses.

private val CODECS = listOf(
    Regex("^(avc[13]|h264|video/avc)", RegexOption.IGNORE_CASE) to "H.264",
    Regex("^(hvc1|hev1|hevc|h265|video/hevc)", RegexOption.IGNORE_CASE) to "H.265",
    Regex("^(video/mpeg2|mpeg2)", RegexOption.IGNORE_CASE) to "MPEG-2",
    Regex("""^(vp09|vp9|video/x-vnd\.on2\.vp9)""", RegexOption.IGNORE_CASE) to "VP9",
    Regex("^(av01|video/av01)", RegexOption.IGNORE_CASE) to "AV1",
    Regex("""^(mp4a\.40\.34|mp4a\.6b|mp3|audio/mpeg$)""", RegexOption.IGNORE_CASE) to "MP3",
    Regex("^(mp4a|aac|audio/mp4a-latm)", RegexOption.IGNORE_CASE) to "AAC",
    Regex("^(ac-3|ac3|audio/ac3)", RegexOption.IGNORE_CASE) to "AC-3",
    Regex("^(ec-3|eac3|audio/eac3)", RegexOption.IGNORE_CASE) to "E-AC-3",
    Regex("^(opus|audio/opus)", RegexOption.IGNORE_CASE) to "Opus",
)

/** "avc1.64001f" or "video/avc" → "H.264"; an unknown codec as it is. */
fun codecLabel(codec: String?): String {
    val c = codec?.trim().orEmpty()
    if (c.isEmpty()) return ""
    return CODECS.firstOrNull { (re, _) -> re.containsMatchIn(c) }?.second ?: c
}

/** 640000 → "640 kb/s", 4250000 → "4.3 Mb/s"; nothing known → "—". */
fun formatBitrate(bps: Long?): String = when {
    bps == null || bps <= 0 -> "—"
    bps < 1_000_000 -> "${(bps + 500) / 1000} kb/s"
    else -> String.format(Locale.US, "%.1f Mb/s", bps / 1_000_000.0)
}

/** The server's delivery (GET /api/activity/delivery), in words. */
fun deliveryText(mode: String?, detail: String?): String {
    val more = if (detail.isNullOrEmpty()) "" else " ($detail)"
    return when (mode) {
        "direct" -> "Straight from the provider"
        "relayed" -> "Relayed by the server$more"
        "repackaged" -> "Repackaged by the server (no quality loss)"
        "converted" -> "Converted by the server$more"
        else -> "—"
    }
}
