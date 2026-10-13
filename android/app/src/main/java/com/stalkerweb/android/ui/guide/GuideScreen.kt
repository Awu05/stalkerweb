package com.stalkerweb.android.ui.guide

import android.Manifest
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.repo.eventAt
import com.stalkerweb.android.data.repo.eventSpan
import com.stalkerweb.android.data.repo.progressOf
import com.stalkerweb.android.data.repo.slotStart
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val MINUTE: Dp = 6.dp
private val ROW: Dp = 64.dp
private val CHANNEL_COL: Dp = 180.dp
private const val BEFORE_SECS = 30 * 60L
private const val WINDOW_SECS = 24 * 3600L + BEFORE_SECS

private val hm = SimpleDateFormat("HH:mm", Locale.getDefault())
private fun clock(secs: Long): String = hm.format(Date(secs * 1000))

/**
 * The guide: a timeline grid on TV and wide screens (channels down the side,
 * programmes across; the remote moves Up/Down between channels and
 * Left/Right between programmes), a channel → schedule list on phones.
 * OK on a programme: details, with Watch (on now) or Remind me (later).
 */
@Composable
fun GuideScreen(viewModel: GuideViewModel, onWatch: (Channel) -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val reminders by viewModel.reminders.list.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val wide = isTV || LocalConfiguration.current.screenWidthDp >= 600
    val context = LocalContext.current
    var details by remember { mutableStateOf<Pair<Channel, EpgEvent>?>(null) }
    var phoneChannel by remember { mutableStateOf<Channel?>(null) }
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val nowSecs = remember(state.epg) { System.currentTimeMillis() / 1000 }

    fun toggleReminder(ch: Channel, e: EpgEvent) {
        if (Build.VERSION.SDK_INT >= 33) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        val set = viewModel.reminders.toggle(ch.uniqueId, ch.name, e)
        Toast.makeText(context, if (set) "We'll remind you when ${e.title} starts" else "Reminder removed", Toast.LENGTH_SHORT).show()
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!wide && phoneChannel != null) IconButton(onClick = { phoneChannel = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Channels") }
            Text(phoneChannel?.name ?: "Guide", style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.weight(1f))
            IconButton(onClick = { viewModel.load(force = true) }) { Icon(Icons.Default.Refresh, "Refresh guide") }
        }
        if (phoneChannel == null) {
            LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Pill("All", state.filter == null, { viewModel.setFilter(null) }) }
                item { Pill("Favorites", state.filter == FAVORITES_FILTER, { viewModel.setFilter(FAVORITES_FILTER) }, leading = Icons.Default.Favorite) }
                items(state.groups, key = { it.id }) { g -> Pill(g.name, state.filter == g.id, { viewModel.setFilter(g.id) }) }
            }
        }
        when {
            state.loading && state.channels.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            state.error != null && state.channels.isEmpty() -> EmptyState(Icons.Default.GridView, "Couldn't load the guide", state.error) {
                Button(onClick = { viewModel.load(force = true) }) { Text("Retry") }
            }
            state.shown.isEmpty() -> EmptyState(Icons.Default.GridView, "No guide data", "The portal has no programmes for these channels.")
            wide -> GuideGrid(state, nowSecs, reminders.map { it.id }.toSet()) { ch, e -> details = ch to e }
            phoneChannel == null -> LazyColumn {
                items(state.shown, key = { it.uniqueId }) { ch ->
                    val now = eventAt(state.epg[ch.uniqueId].orEmpty(), nowSecs)
                    Row(Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { phoneChannel = ch }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Logo(state.logoMap[ch.uniqueId], 40.dp)
                        Column(Modifier.weight(1f)) {
                            Text(ch.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(now?.title ?: "—", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            else -> {
                val ch = phoneChannel!!
                val events = state.epg[ch.uniqueId].orEmpty().filter { it.endTime > nowSecs }
                LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(events, key = { it.startTime }) { e ->
                        val on = e.startTime <= nowSecs
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(if (on) SwColors.Surface2 else SwColors.Surface)
                                .tvFocus(RoundedCornerShape(8.dp)).clickable { details = ch to e }.padding(12.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("${clock(e.startTime)}–${clock(e.endTime)}", color = SwColors.Muted, style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(96.dp))
                                Text(e.title, color = SwColors.Text, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                if (reminders.any { it.id == "${ch.uniqueId}:${e.startTime}" }) Icon(Icons.Default.NotificationsActive, "Reminder set", Modifier.size(16.dp), tint = SwColors.Warning)
                            }
                            if (on) LinearProgressIndicator(progress = { progressOf(e, nowSecs) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp).height(3.dp), color = SwColors.Primary, trackColor = SwColors.Surface3)
                        }
                    }
                }
            }
        }
    }

    details?.let { (ch, e) ->
        val on = e.startTime <= nowSecs && e.endTime > nowSecs
        val set = reminders.any { it.id == "${ch.uniqueId}:${e.startTime}" }
        AlertDialog(
            onDismissRequest = { details = null },
            title = { Text(e.title) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${ch.name} · ${clock(e.startTime)}–${clock(e.endTime)}", color = SwColors.Muted)
                    if (e.description.isNotBlank()) Text(e.description, color = SwColors.Text, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                when {
                    on -> Button(onClick = { details = null; onWatch(ch) }) { Text("Watch") }
                    e.startTime > nowSecs -> Button(onClick = { toggleReminder(ch, e); details = null }) {
                        Icon(if (set) Icons.Default.NotificationsActive else Icons.Default.Notifications, null, Modifier.size(16.dp))
                        Text(if (set) "  Remove reminder" else "  Remind me")
                    }
                    else -> {}
                }
            },
            dismissButton = { TextButton(onClick = { details = null }) { Text("Close") } },
        )
    }
}

@Composable
private fun Logo(url: String?, size: Dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(6.dp)).background(SwColors.Surface2), Alignment.Center) {
        if (url != null) AsyncImage(url, null, Modifier.size(size - 4.dp), contentScale = ContentScale.Fit)
        else Icon(Icons.Default.Tv, null, Modifier.size(size / 2), tint = SwColors.Muted)
    }
}

/** Channels down the side, a 24-hour timeline across — every row sharing one horizontal scroll. */
@Composable
private fun GuideGrid(state: GuideState, nowSecs: Long, reminderIds: Set<String>, onOpen: (Channel, EpgEvent) -> Unit) {
    val windowStart = slotStart(nowSecs) - BEFORE_SECS
    val windowEnd = windowStart + WINDOW_SECS
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val timelineWidth = MINUTE * (WINDOW_SECS / 60f)
    // Open at about now (a slot before it).
    LaunchedEffect(Unit) { scroll.scrollTo(with(density) { (MINUTE * ((nowSecs - windowStart - 15 * 60) / 60f)).roundToPx() }) }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().height(28.dp)) {
            Box(Modifier.width(CHANNEL_COL))
            Box(Modifier.weight(1f).horizontalScroll(scroll)) {
                Box(Modifier.width(timelineWidth).fillMaxHeight()) {
                    var t = windowStart
                    while (t < windowEnd) {
                        Text(clock(t), style = MaterialTheme.typography.labelSmall, color = SwColors.Muted,
                            modifier = Modifier.offset(x = MINUTE * ((t - windowStart) / 60f)).padding(start = 4.dp))
                        t += 30 * 60
                    }
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(state.shown, key = { it.uniqueId }) { ch ->
                GuideRow(ch, state.logoMap[ch.uniqueId], state.epg[ch.uniqueId].orEmpty(), windowStart, windowEnd, nowSecs, scroll, timelineWidth, reminderIds, onOpen)
            }
        }
    }
}

@Composable
private fun GuideRow(
    ch: Channel, logo: String?, events: List<EpgEvent>, windowStart: Long, windowEnd: Long, nowSecs: Long,
    scroll: ScrollState, timelineWidth: Dp, reminderIds: Set<String>, onOpen: (Channel, EpgEvent) -> Unit,
) {
    Row(Modifier.fillMaxWidth().height(ROW).padding(vertical = 2.dp)) {
        Row(Modifier.width(CHANNEL_COL).fillMaxHeight().background(SwColors.Surface).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Logo(logo, 40.dp)
            Text(ch.name, color = SwColors.Text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.weight(1f).fillMaxHeight().horizontalScroll(scroll)) {
            Box(Modifier.width(timelineWidth).fillMaxHeight()) {
                events.forEach { e ->
                    val span = eventSpan(e, windowStart, windowEnd) ?: return@forEach
                    val on = e.startTime <= nowSecs && e.endTime > nowSecs
                    Box(
                        Modifier.offset(x = MINUTE * span.offsetMinutes).width((MINUTE * span.durationMinutes - 2.dp).coerceAtLeast(4.dp)).fillMaxHeight()
                            .tvFocus(RoundedCornerShape(6.dp))
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (on) SwColors.Surface3 else SwColors.Surface2)
                            .clickable { onOpen(ch, e) }
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                    ) {
                        Column {
                            Text(e.title, color = SwColors.Text, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(clock(e.startTime), color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
                                if ("${ch.uniqueId}:${e.startTime}" in reminderIds) Icon(Icons.Default.NotificationsActive, "Reminder set", Modifier.padding(start = 4.dp).size(12.dp), tint = SwColors.Warning)
                            }
                        }
                    }
                }
                // Now
                Box(Modifier.offset(x = MINUTE * ((nowSecs - windowStart) / 60f)).width(2.dp).fillMaxHeight().background(SwColors.Live))
            }
        }
    }
}
