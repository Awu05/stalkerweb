package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.api.StreamDelivery
import com.stalkerweb.android.data.repo.StatsRepository
import com.stalkerweb.android.data.repo.codecLabel
import com.stalkerweb.android.data.repo.deliveryText
import com.stalkerweb.android.data.repo.formatBitrate
import com.stalkerweb.android.service.PlaybackSnapshot
import com.stalkerweb.android.service.PlaybackStats
import com.stalkerweb.android.ui.theme.SwColors
import kotlinx.coroutines.delay
import java.util.Locale
import kotlin.math.roundToInt

/** The player's Stats button. */
@Composable
fun StatsButton(open: Boolean, onToggle: () -> Unit) {
    TipIconButton(label = if (open) "Hide stats" else "Show stats", onClick = onToggle) {
        Icon(Icons.Default.BarChart, if (open) "Hide stats" else "Show stats", tint = if (open) MaterialTheme.colorScheme.primary else Color.White)
    }
}

/**
 * Stats for what's playing (the web's StreamStats.jsx): the picture, playback
 * health and the connection to the server. Samples the player every second,
 * the server every five, while shown. [kind] live | vod, [id] the channel or
 * the movie's key, as the server's Activity knows them.
 */
@Composable
fun StreamStatsOverlay(stats: StatsRepository, kind: String, id: String?, modifier: Modifier = Modifier) {
    var snap by remember { mutableStateOf<PlaybackSnapshot?>(null) }
    var pingMs by remember { mutableStateOf<Long?>(null) }
    var delivery by remember { mutableStateOf<StreamDelivery?>(null) }

    LaunchedEffect(Unit) {
        while (true) { snap = PlaybackStats.snapshot(); delay(1_000) }
    }
    LaunchedEffect(kind, id) {
        while (true) {
            pingMs = runCatching { stats.pingMs() }.getOrNull()
            delivery = if (id.isNullOrEmpty()) null else runCatching { stats.delivery(kind, id) }.getOrNull()
            delay(5_000)
        }
    }

    val s = snap
    val rows = if (s == null) emptyList() else listOf(
        "Resolution" to (if (s.width > 0 && s.height > 0) "${s.width}×${s.height}" else "—"),
        "Frame rate" to (s.frameRate?.let { "${it.roundToInt()} fps" } ?: "—"),
        "Video · audio" to "${codecLabel(s.videoCodec).ifEmpty { "?" }} · ${codecLabel(s.audioCodec).ifEmpty { "?" }}",
        "Bitrate" to formatBitrate(s.bitrate),
        "Buffered ahead" to String.format(Locale.US, "%.1f s", s.bufferedMs / 1000.0),
        "Dropped frames" to s.droppedFrames.toString(),
        "Stalls" to s.stalls.toString(),
        "Download speed" to formatBitrate(s.bandwidth),
        "Server round trip" to (pingMs?.let { "$it ms" } ?: "—"),
        "Delivery" to deliveryText(delivery?.mode, delivery?.detail),
    )
    Column(
        modifier
            .widthIn(max = 300.dp)
            .background(Color.Black.copy(alpha = 0.75f), RoundedCornerShape(10.dp))
            .verticalScroll(rememberScrollState())   // scrolls where it doesn't fit (a phone's portrait video)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("Stats", color = Color.White, style = MaterialTheme.typography.labelLarge)
        if (rows.isEmpty()) Text("Measuring…", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
        rows.forEach { (k, v) ->
            Row {
                Text(k, color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.width(12.dp))
                Text(v, color = Color.White, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.End, modifier = Modifier.weight(1f))
            }
        }
    }
}
