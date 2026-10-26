package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Test

class StreamStatsTest {
    @Test fun `names the codecs players report`() {
        assertEquals("H.264", codecLabel("avc1.64001f"))
        assertEquals("H.264", codecLabel("video/avc"))
        assertEquals("H.265", codecLabel("hvc1.2.4.L153.B0"))
        assertEquals("H.265", codecLabel("video/hevc"))
        assertEquals("AAC", codecLabel("mp4a.40.2"))
        assertEquals("AAC", codecLabel("audio/mp4a-latm"))
        assertEquals("MP3", codecLabel("audio/mpeg"))
        assertEquals("AC-3", codecLabel("audio/ac3"))
        assertEquals("E-AC-3", codecLabel("audio/eac3"))
        assertEquals("MPEG-2", codecLabel("video/mpeg2"))
        assertEquals("flac", codecLabel("flac"))
        assertEquals("", codecLabel(null))
    }

    @Test fun `uses kb per second below a megabit, Mb per second above`() {
        assertEquals("640 kb/s", formatBitrate(640_000))
        assertEquals("4.3 Mb/s", formatBitrate(4_250_000))
        assertEquals("—", formatBitrate(0))
        assertEquals("—", formatBitrate(null))
    }

    @Test fun `says how the server sends the stream, as the web does`() {
        assertEquals("Straight from the provider", deliveryText("direct", ""))
        assertEquals("Relayed by the server (HLS)", deliveryText("relayed", "HLS"))
        assertEquals("Repackaged by the server (no quality loss)", deliveryText("repackaged", ""))
        assertEquals("Converted by the server (audio → AAC)", deliveryText("converted", "audio → AAC"))
        assertEquals("—", deliveryText(null, null))
    }
}
