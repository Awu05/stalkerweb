package com.stalkerweb.android.ui.settings

import com.stalkerweb.android.ui.components.TvTextField

import com.stalkerweb.android.ui.components.TipIconButton

import com.stalkerweb.android.ui.components.tvKeyboardOptions
import com.stalkerweb.android.data.repo.normalizeMac
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.focusable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.SettingsUpdate
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.repo.linksFor
import com.stalkerweb.android.data.repo.kindLabel
import com.stalkerweb.android.data.repo.playingFor
import com.stalkerweb.android.data.repo.portalSummary
import com.stalkerweb.android.data.repo.viaLabel
import com.stalkerweb.android.data.repo.FiltersToSave
import com.stalkerweb.android.data.repo.filtersToSave
import com.stalkerweb.android.data.repo.shownWith
import com.stalkerweb.android.data.repo.titleKey
import com.stalkerweb.android.ui.channels.NameDialog
import com.stalkerweb.android.ui.components.PasswordEye
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.passwordTransformation
import com.stalkerweb.android.ui.components.ViewerAvatar
import com.stalkerweb.android.ui.theme.VIEWER_COLORS
import com.stalkerweb.android.ui.components.TimezoneField
import com.stalkerweb.android.data.repo.deviceIdSourceOf
import com.stalkerweb.android.data.repo.missingProfileFields
import com.stalkerweb.android.data.repo.deviceIdFrom
import com.stalkerweb.android.data.repo.DeviceIdSource
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.update.UpdateViewModel
import com.stalkerweb.android.ui.utils.rememberIsTV


/** Settings, with the web's tabs: Viewers, Connection, Links, Playback, Logos — and App (version, updates). */
@Composable
fun SettingsScreen(viewModel: SettingsViewModel, updates: UpdateViewModel, serverUrl: String?, onOpenServer: () -> Unit, onOwnViewerDeleted: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val viewer by viewModel.viewers.current.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    Column(Modifier.fillMaxSize()) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall, color = SwColors.Text, modifier = Modifier.padding(start = 16.dp, top = 12.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(SETTINGS_TABS, key = { it.first }) { (id, label) -> Pill(label, state.tab == id, { viewModel.setTab(id) }) }
        }
        HorizontalDivider(color = SwColors.Border)
        Box(Modifier.fillMaxSize().padding(16.dp)) {
            when (state.tab) {
                "viewers" -> ViewersTab(viewModel, state, onOwnViewerDeleted)
                "connection" -> ConnectionTab(viewModel, state, serverUrl, onOpenServer)
                "links" -> LinksTab(state, serverUrl, viewModel.viewers.savedViewerId(), viewer?.name)
                "playback" -> PlaybackTab(viewModel, state)
                "logos" -> LogosTab(viewModel, state)
                "activity" -> ActivityTab(viewModel, state)
                "app" -> AppTab(updates)
            }
        }
    }
}

@Composable
private fun Card(title: String, description: String? = null, content: @Composable () -> Unit) {
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().widthIn(max = 900.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = SwColors.Text)
            if (description != null) Text(description, style = MaterialTheme.typography.bodySmall, color = SwColors.Muted)
            content()
        }
    }
}

// ── Viewers ───────────────────────────────────────────────────────────────────

@Composable
private fun ViewersTab(viewModel: SettingsViewModel, state: SettingsState, onOwnViewerDeleted: () -> Unit) {
    val me by viewModel.viewers.current.collectAsStateWithLifecycle()
    var renaming by remember { mutableStateOf<ViewerSummary?>(null) }
    var deleting by remember { mutableStateOf<ViewerSummary?>(null) }
    var adding by remember { mutableStateOf(false) }
    // The filter checklists, edited here and saved together.
    val oldLanguages = me?.disabledLanguages.orEmpty()
    var shownGenres by remember(me?.id, oldLanguages, state.genres) { mutableStateOf(shownWith(state.genres, me?.disabledGenres.orEmpty(), oldLanguages)) }
    val allCats = (state.movieCategories + state.seriesCategories).distinct()
    var shownCats by remember(me?.id, oldLanguages, allCats) { mutableStateOf(shownWith(allCats, me?.disabledVodCategories.orEmpty(), oldLanguages, ::titleKey)) }
    var showAdult by remember(me?.id) { mutableStateOf(me?.showAdult == true) }
    val save = {
        viewModel.saveFilters(
            filtersToSave(me?.disabledGenres.orEmpty(), me?.disabledVodCategories.orEmpty(), oldLanguages, state.genres, shownGenres, allCats, shownCats),
            showAdult,
        )
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Card("Viewers", "Everyone who watches here. Each viewer has their own favorites, history, My List and filters.") {
                state.viewers.forEach { v ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ViewerAvatar(v.name, v.color, 32.dp)
                        Text(v.name + if (v.id == me?.id) "  · you" else "", color = SwColors.Text, modifier = Modifier.weight(1f))
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.widthIn(max = 240.dp)) {
                            items(VIEWER_COLORS) { c ->
                                Box(Modifier.size(22.dp).tvFocus(CircleShape).background(c.color, CircleShape).clickable { viewModel.recolor(v, c.hex) })
                            }
                        }
                        TipIconButton(label = "Rename ${v.name}", onClick = { renaming = v }) { Icon(Icons.Default.Edit, "Rename ${v.name}") }
                        TipIconButton(label = "Delete ${v.name}", onClick = { deleting = v }) { Icon(Icons.Default.Delete, "Delete ${v.name}", tint = SwColors.Live) }
                    }
                }
                OutlinedButton(onClick = { adding = true }) { Icon(Icons.Default.Add, null); Text(" Add viewer") }
            }
        }
        // Save first: the checklists below can run to hundreds of rows.
        item {
            Card("${me?.name ?: "Your"}'s filters", "What this viewer sees. Change the lists below, then save.") {
                Button(onClick = save, enabled = !state.busy && me != null) { Text("Save ${me?.name ?: "viewer"}'s filters") }
            }
        }
        // The older filter hid whole languages; each can be shown again here, as on the web.
        if (oldLanguages.isNotEmpty()) item {
            Card("Hidden languages", "An older filter hides everything in these languages, including categories the portal adds later.") {
                oldLanguages.sorted().forEach { lang ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(lang, color = SwColors.Text, modifier = Modifier.weight(1f))
                        OutlinedButton(onClick = {
                            val me0 = me ?: return@OutlinedButton
                            viewModel.saveFilters(FiltersToSave(me0.disabledGenres, me0.disabledVodCategories, oldLanguages - lang), showAdult)
                        }, enabled = !state.busy) { Text("Show again") }
                    }
                }
            }
        }
        item {
            Card("${me?.name ?: "Your"}'s channels", if (state.genres.isEmpty()) "Connect to a portal to choose genres." else "Live TV genres shown to this viewer.") {
                Row { TextButton(onClick = { shownGenres = state.genres.toSet() }) { Text("All") }; TextButton(onClick = { shownGenres = emptySet() }) { Text("None") } }
            }
        }
        items(state.genres, key = { "g-$it" }) { g ->
            CheckRow(g, g in shownGenres) { on -> shownGenres = if (on) shownGenres + g else shownGenres - g }
        }
        item {
            Card("Movies & Series", if (allCats.isEmpty()) "Connect to a portal to choose categories." else "Portal categories shown to this viewer.") {
                Row { TextButton(onClick = { shownCats = allCats.toSet() }) { Text("All") }; TextButton(onClick = { shownCats = emptySet() }) { Text("None") } }
            }
        }
        items(allCats, key = { "c-$it" }) { c ->
            CheckRow(c, c in shownCats) { on -> shownCats = if (on) shownCats + c else shownCats - c }
        }
        item {
            Card(me?.name?.let { "$it's playback" } ?: "Your playback", "Skip intros and recaps without asking, where their times are known (from IntroDB, a community database). Otherwise a Skip button shows while they play; credits are never skipped by themselves.") {
                Row(Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable(enabled = me != null && !state.busy) { viewModel.setAutoSkip(me?.autoSkip != true) }.padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("Skip intros & recaps automatically", color = SwColors.Text, modifier = Modifier.weight(1f))
                    Switch(checked = me?.autoSkip == true, onCheckedChange = null)
                }
            }
        }
        item {
            Card("Adult content") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Show adult channels and categories", color = SwColors.Text, modifier = Modifier.weight(1f))
                    Switch(checked = showAdult, onCheckedChange = { showAdult = it })
                }
                Button(onClick = save, enabled = !state.busy && me != null) {
                    Text("Save ${me?.name ?: "viewer"}'s filters")
                }
            }
        }
    }

    renaming?.let { v -> NameDialog("Rename viewer", v.name, onSave = { viewModel.rename(v, it) }, onDismiss = { renaming = null }) }
    if (adding) NameDialog("Add viewer", "", onSave = viewModel::addViewer, onDismiss = { adding = false })
    deleting?.let { v ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${v.name}?") },
            text = { Text("Their favorites, history, My List and filters are deleted too.") },
            confirmButton = { Button(onClick = { deleting = null; viewModel.deleteViewer(v, onOwnViewerDeleted) }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { onChange(!checked) }.padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onChange)
        Text(label, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Connection ────────────────────────────────────────────────────────────────

// ── Activity ──────────────────────────────────────────────────────────────────

@Composable
private fun ActivityTab(viewModel: SettingsViewModel, state: SettingsState) {
    // Polled while the tab is on screen and the app in front — not after Home
    // or with the screen off (the composition stays, so onDispose alone won't).
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(viewModel, lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_START -> viewModel.watchActivity(true)
                androidx.lifecycle.Lifecycle.Event.ON_STOP -> viewModel.watchActivity(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)   // ON_START comes at once when already started
        onDispose { lifecycle.removeObserver(observer); viewModel.watchActivity(false) }
    }
    val a = state.activity
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card("Activity", "Everything playing through this server right now — who's watching, what, and on which device: the website and the apps, TVs being cast to, and IPTV players using your Xtream, M3U or Stremio links.") {
            state.activityError?.let { Text(it, color = SwColors.Live, style = MaterialTheme.typography.bodySmall) }
            if (a == null) {
                if (state.activityError == null) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                return@Card
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(8.dp).background(if (a.portal.connected) SwColors.Success else SwColors.Muted, CircleShape))
                Text(portalSummary(a.portal), color = SwColors.Muted, style = MaterialTheme.typography.labelMedium)
            }
            if (a.streams.isEmpty()) {
                Text("Nothing is playing right now.", color = SwColors.Muted, modifier = Modifier.padding(vertical = 12.dp))
            }
            a.streams.forEach { s ->
                // Focusable, so a TV remote can scroll through them.
                Row(
                    Modifier.fillMaxWidth().tvFocus().focusable().padding(vertical = 6.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    ViewerAvatar(s.viewer?.name ?: "?", s.viewer?.color, 30.dp)
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(s.title, color = SwColors.Text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            val badge = kindLabel(s)
                            Surface(color = if (badge == "Live") SwColors.Live.copy(alpha = 0.15f) else SwColors.Surface2, shape = RoundedCornerShape(4.dp)) {
                                Text(badge.uppercase(), color = if (badge == "Live") SwColors.Live else SwColors.Muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp))
                            }
                        }
                        if (s.subtitle.isNotBlank()) Text(s.subtitle, color = SwColors.Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val via = viaLabel(s).let { if (it.isEmpty()) "" else " · $it" }
                        Text("${s.viewer?.name ?: "Unknown viewer"} · ${s.device}$via · ${s.ip}", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    Text(playingFor(s.startedAt, a.now), color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
                }
            }
            a.downloads.forEach { d ->
                Text("Downloading ${d.title}${d.percent?.let { " $it%" } ?: ""}", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
            }
            Text("Updates every few seconds. A stream drops off about 30 s after it stops.", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
        }
    }
}

// ── App ───────────────────────────────────────────────────────────────────────

@Composable
private fun AppTab(updates: UpdateViewModel) {
    val status by updates.checkStatus.collectAsStateWithLifecycle()
    val checking by updates.checking.collectAsStateWithLifecycle()
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card(
            "App updates",
            "StalkerWeb ${if (BuildConfig.IS_TV) "TV" else "mobile"} · version ${BuildConfig.VERSION_NAME}. New releases come from github.com/${BuildConfig.GITHUB_REPO}; the app also checks each time it starts.",
        ) {
            OutlinedButton(onClick = updates::checkNow, enabled = !checking) { Icon(Icons.Default.SystemUpdate, null); Text(" Check for updates") }
            status?.let { Text(it, color = SwColors.Muted, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun ConnectionTab(viewModel: SettingsViewModel, state: SettingsState, serverUrl: String?, onOpenServer: () -> Unit) {
    var editing by remember { mutableStateOf<Profile?>(null) }
    var deleting by remember { mutableStateOf<Profile?>(null) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card("StalkerWeb server", serverUrl ?: "Not set up") {
            OutlinedButton(onClick = onOpenServer) { Icon(Icons.Default.Dns, null); Text(" Change server or access key") }
        }
        Card("IPTV connections", if (state.status?.connected == true) "Connected to ${state.status.portal}" else "Not connected") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = viewModel::reconnect, enabled = !state.busy) { Text("Reconnect") }
                OutlinedButton(onClick = viewModel::disconnect, enabled = !state.busy && state.status?.connected == true) { Text("Disconnect") }
                OutlinedButton(onClick = { editing = Profile(id = "") }) { Icon(Icons.Default.Add, null); Text(" Add") }
            }
            state.profiles.profiles.forEach { p ->
                val active = p.id == state.profiles.activeProfileId
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name.ifBlank { p.portal } + if (active) "  · active" else "", color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${p.portal} · ${p.mac}", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Button(onClick = { viewModel.connect(p) }, enabled = !state.busy) { Text(if (active) "Reconnect" else "Connect") }
                    TipIconButton(label = "Edit ${p.name}", onClick = { editing = p }) { Icon(Icons.Default.Edit, "Edit ${p.name}") }
                    TipIconButton(label = "Delete ${p.name}", onClick = { deleting = p }) { Icon(Icons.Default.Delete, "Delete ${p.name}", tint = SwColors.Live) }
                }
            }
        }
        Card("Device profile", "The STB identity sent to the portal — change it on the web.") {
            Text("Model: ${state.settings?.stbModel.orEmpty().ifBlank { "MAG250" }}", color = SwColors.Text)
            Text("Firmware: ${state.settings?.firmware.orEmpty().ifBlank { "default" }}", color = SwColors.Text)
        }
    }
    editing?.let { p -> ProfileDialog(p, onSave = { viewModel.saveProfile(it) }, onDismiss = { editing = null }) }
    deleting?.let { p ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${p.name.ifBlank { p.portal }}?") },
            confirmButton = { Button(onClick = { deleting = null; viewModel.deleteProfile(p) }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ProfileDialog(initial: Profile, onSave: (Profile) -> Unit, onDismiss: () -> Unit) {
    var p by remember { mutableStateOf(initial) }
    // Device ID 1 and 2, made from the MAC, the serial or the UID as the
    // provider wants them (DeviceId.kt) — kept in step while one is chosen.
    // Starts on the one the saved IDs already are.
    var idSource by remember { mutableStateOf(deviceIdSourceOf(initial.mac, initial.serialNumber, initial.uid, initial.deviceId, initial.deviceId2)) }
    val made = idSource != DeviceIdSource.TYPED
    fun withIds(q: Profile, source: DeviceIdSource = idSource): Profile =
        deviceIdFrom(source, q.mac, q.serialNumber, q.uid).let { id -> if (id.isEmpty()) q else q.copy(deviceId = id, deviceId2 = id) }
    // The IDs typed in before one was chosen, put back on "Typed in" (an STBEmu import's own, say).
    var idsBefore by remember { mutableStateOf<Pair<String, String>?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial.id.isBlank()) "Add IPTV connection" else "Edit IPTV connection") },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                @Composable fun field(label: String, value: String, readOnly: Boolean = false, required: Boolean = false, set: (String) -> Unit) =
                    TvTextField(value, set, singleLine = true, keyboardOptions = tvKeyboardOptions(), readOnly = readOnly,
                        label = { Text(if (required) "$label *" else label) }, modifier = Modifier.fillMaxWidth())
                Text("* required", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
                field("Name", p.name, required = true) { p = p.copy(name = it) }
                field("Portal URL", p.portal, required = true) { p = p.copy(portal = it) }
                field("MAC address", p.mac, required = true) { p = p.copy(mac = it).let { q -> if (made) withIds(q) else q } }
                Text("Device ID 1 and 2 (SHA-256 of…)", color = SwColors.Muted, style = MaterialTheme.typography.labelMedium)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(DeviceIdSource.entries) { source ->
                        Pill(source.label, source == idSource, {
                            if (!made && source != DeviceIdSource.TYPED) idsBefore = p.deviceId to p.deviceId2
                            idSource = source
                            if (source != DeviceIdSource.TYPED) p = withIds(p, source)
                            else idsBefore?.let { (a, b) -> p = p.copy(deviceId = a, deviceId2 = b); idsBefore = null }
                        })
                    }
                }
                if (made && deviceIdFrom(idSource, p.mac, p.serialNumber, p.uid).isEmpty()) {
                    val from = when (idSource) { DeviceIdSource.SERIAL -> "the serial number"; DeviceIdSource.UID -> "the UID"; else -> "the MAC" }
                    Text("The device IDs fill in once $from is filled in.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
                TimezoneField(p.timezone, { p = p.copy(timezone = it) }, Modifier.fillMaxWidth(), label = "Timezone *")
                field("Language", p.lang, required = true) { p = p.copy(lang = it) }
                field("Login", p.login) { p = p.copy(login = it) }
                var passwordShown by remember { mutableStateOf(false) }
                TvTextField(
                    p.password, { p = p.copy(password = it) }, singleLine = true, label = { Text("Password") },
                    visualTransformation = passwordTransformation(passwordShown),
                    keyboardOptions = tvKeyboardOptions(KeyboardOptions(keyboardType = KeyboardType.Password)),
                    trailingIcon = { PasswordEye(passwordShown) { passwordShown = !passwordShown } },
                    modifier = Modifier.fillMaxWidth(),
                )
                field("Token", p.token) { p = p.copy(token = it) }
                field("Serial number", p.serialNumber, required = true) { p = p.copy(serialNumber = it).let { q -> if (made) withIds(q) else q } }
                field("UID (System information; only to make the device IDs)", p.uid) { p = p.copy(uid = it).let { q -> if (made) withIds(q) else q } }
                field("Device ID", p.deviceId, readOnly = made, required = p.sendDeviceId) { p = p.copy(deviceId = it) }
                field("Device ID 2", p.deviceId2, readOnly = made, required = p.sendDeviceId2) { p = p.copy(deviceId2 = it) }
                field("Signature", p.signature) { p = p.copy(signature = it) }
                val missing = missingProfileFields(p)
                if (missing.isNotEmpty()) Text("* Still needed: ${missing.joinToString(", ")}", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { Button(onClick = { onSave(p.copy(mac = normalizeMac(p.mac).ifEmpty { p.mac })); onDismiss() }, enabled = missingProfileFields(p).isEmpty()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ── Links ─────────────────────────────────────────────────────────────────────

@Composable
private fun LinksTab(state: SettingsState, serverUrl: String?, viewerId: String?, viewerName: String?) {
    val context = LocalContext.current
    val isTV = rememberIsTV()
    val s = state.settings
    if (serverUrl == null) { Text("Set up a server first.", color = SwColors.Muted); return }
    val links = linksFor(serverUrl, s?.accessShareToken?.takeIf { s.accessEnabled }, viewerId, s?.httpsPort, viewerName)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Add StalkerWeb to Jellyfin, Plex, Emby, Stremio or any IPTV app with these links. They're this viewer's.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall) }
        items(links, key = { it.label }) { link ->
            Card(link.label, link.hint.ifBlank { null }) {
                Text(link.url, color = SwColors.Text, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { copy(context, link.label, link.url) }) { Icon(Icons.Default.ContentCopy, null); Text(" Copy") }
                    if (!isTV) OutlinedButton(onClick = {
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link.url), link.label))
                    }) { Icon(Icons.Default.Share, null); Text(" Share") }
                }
            }
        }
    }
}

private fun copy(context: Context, label: String, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, text))
    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

// ── Playback ──────────────────────────────────────────────────────────────────

@Composable
private fun PlaybackTab(viewModel: SettingsViewModel, state: SettingsState) {
    val s = state.settings ?: run { Text("Loading…", color = SwColors.Muted); return }
    var vod by remember(s) { mutableStateOf(s.vodEnabled) }
    var epg by remember(s) { mutableStateOf(s.epgEnabled) }
    var buffer by remember(s) { mutableStateOf(s.liveBufferSeconds) }
    var idle by remember(s) { mutableStateOf(s.idleTimeoutMinutes ?: 0) }
    var dir by remember(s) { mutableStateOf(s.downloadDir) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card("Playback & Guide", "Shared by every viewer.") {
            SwitchRow("VOD (movies & series)", vod) { vod = it }
            SwitchRow("Programme guide", epg) { epg = it }
            Text("Live buffer", color = SwColors.Text)
            ChoiceRow(listOf(0, 5, 10, 15, 30, 60), buffer, { if (it == 0) "Off" else "$it s" }) { buffer = it }
            Text("Disconnect when idle", color = SwColors.Text)
            ChoiceRow(listOf(0, 15, 30, 60, 120, 240), idle, { if (it == 0) "Never" else if (it < 60) "$it min" else "${it / 60} h" }) { idle = it }
            TvTextField(dir, { dir = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Download folder (on the server)") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = {
                viewModel.savePlayback(SettingsUpdate(epgEnabled = epg, vodEnabled = vod, downloadDir = dir.trim().ifBlank { null },
                    idleTimeoutMinutes = idle, liveBufferSeconds = buffer))
            }, enabled = !state.busy) { Text("Save") }
        }
    }
}

@Composable
private fun SwitchRow(label: String, on: Boolean, set: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = SwColors.Text, modifier = Modifier.weight(1f))
        Switch(checked = on, onCheckedChange = set)
    }
}

@Composable
private fun ChoiceRow(values: List<Int>, selected: Int, label: (Int) -> String, onPick: (Int) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(values) { v -> Pill(label(v), v == selected, { onPick(v) }) }
    }
}

// ── Logos ─────────────────────────────────────────────────────────────────────

@Composable
private fun LogosTab(viewModel: SettingsViewModel, state: SettingsState) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var word by remember { mutableStateOf("") }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Card("Channel logos", "From your portal, filled in from the iptv-org database when it has none.") {
                state.logos?.stats?.let { st ->
                    Text("${st.dbSize} logos in the database · ${st.matchedChannels} of ${st.totalChannels} channels matched · ${st.overridesCount} overrides", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = viewModel::refreshLogos, enabled = !state.busy) { Text("Refresh logo database") }
            }
        }
        item {
            Card("Logo overrides", "A logo for a channel name, used before anything else.") {
                TvTextField(name, { name = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Channel name") }, modifier = Modifier.fillMaxWidth())
                TvTextField(url, { url = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Logo URL") }, modifier = Modifier.fillMaxWidth())
                Button(onClick = { viewModel.addOverride(name, url); name = ""; url = "" }, enabled = name.isNotBlank() && url.isNotBlank()) { Text("Add override") }
            }
        }
        items(state.logos?.overrides?.entries?.toList().orEmpty(), key = { "o-" + it.key }) { (n, u) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(n, color = SwColors.Text)
                    Text(u, color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                TipIconButton(label = "Remove override for $n", onClick = { viewModel.removeOverride(n) }) { Icon(Icons.Default.Close, "Remove override for $n") }
            }
        }
        item {
            Card("Logo strip words", "Removed from channel names before logo matching (e.g. CANADA, so BBC CANADA matches BBC).") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TvTextField(word, { word = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Word") }, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = { viewModel.addStripWord(word); word = "" }, enabled = word.isNotBlank()) { Text("Add") }
                }
            }
        }
        items(state.stripWords, key = { "w-$it" }) { w ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(w, color = SwColors.Text, modifier = Modifier.weight(1f))
                TipIconButton(label = "Remove $w", onClick = { viewModel.removeStripWord(w) }) { Icon(Icons.Default.Close, "Remove $w") }
            }
        }
    }
}
