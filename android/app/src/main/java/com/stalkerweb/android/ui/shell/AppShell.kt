package com.stalkerweb.android.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.ViewList
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.ViewerAvatar
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private data class Section(val route: String, val label: String, val icon: ImageVector)

private val CHANNELS  = Section("channels", "Channels", Icons.Default.Tv)
private val VOD       = Section("vod", "VOD", Icons.Default.Movie)
private val DOWNLOADS = Section("downloads", "Downloads", Icons.Default.Download)
private val GUIDE     = Section("guide", "Guide", Icons.Default.GridView)
private const val SETTINGS = "settings"
private const val STATUS_POLL_MS = 30_000L

/**
 * The app's frame, like the web's sidebar: Channels, VOD, Downloads, Guide,
 * with the viewer, the connection and Settings. A side rail on TVs and wide
 * screens (the remote moves into it with Left), a bottom bar on phones.
 */
@Composable
fun AppShell(
    vm: ShellViewModel,
    channels: @Composable () -> Unit,
    vod: @Composable () -> Unit,
    onSwitchViewer: () -> Unit,
    onOpenServer: () -> Unit,
    onOpenConnection: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val viewer by vm.viewers.current.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val current = nav.currentBackStackEntryAsState().value?.destination?.route
    val scope = rememberCoroutineScope()
    val layout = navLayoutFor(LocalConfiguration.current.screenWidthDp, rememberIsTV())

    // Status every 30 s while the app is in front (as the web does).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { vm.refreshStatus(); delay(STATUS_POLL_MS) }
        }
    }

    val sections = buildList {
        add(CHANNELS)
        if (state.vodEnabled) add(VOD)
        add(DOWNLOADS)
        if (state.epgEnabled) add(GUIDE)
    }
    fun go(route: String) = nav.navigate(route) {
        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }

    val content: @Composable () -> Unit = {
        Column(Modifier.fillMaxSize()) {
            if (state.unreachable) {
                Row(
                    Modifier.fillMaxWidth().background(SwColors.Surface2).padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Default.CloudOff, null, tint = SwColors.Warning, modifier = Modifier.size(18.dp))
                    Text("Can't reach the server", color = SwColors.Text, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { vm.refreshStatus() } }) { Text("Retry") }
                }
            }
            NavHost(nav, startDestination = CHANNELS.route, modifier = Modifier.weight(1f)) {
                composable(CHANNELS.route) { channels() }
                composable(VOD.route) { vod() }
                composable(DOWNLOADS.route) { EmptyState(Icons.Default.Download, "Downloads are coming soon", "For now they're on the web app.") }
                composable(GUIDE.route) { EmptyState(Icons.Default.ViewList, "The guide is coming soon", "For now it's on the web app.") }
                composable(SETTINGS) {
                    com.stalkerweb.android.ui.settings.SettingsScreen(onOpenServer = onOpenServer, onOpenConnection = onOpenConnection)
                }
            }
        }
    }

    if (layout == NavLayout.RAIL) {
        Row(Modifier.fillMaxSize()) {
            NavigationRail(containerColor = SwColors.Bg, modifier = Modifier.width(88.dp)) {
                sections.forEach { s ->
                    NavigationRailItem(
                        selected = current == s.route,
                        onClick = { go(s.route) },
                        icon = { Icon(s.icon, null) },
                        label = { Text(s.label) },
                    )
                }
                Spacer(Modifier.weight(1f))
                viewer?.let { v ->
                    Box(Modifier.tvFocus(RoundedCornerShape(50)).clickable(onClick = onSwitchViewer).padding(8.dp)) {
                        ViewerAvatar(v.name, v.color, 32.dp)
                    }
                }
                state.connection?.let { c ->
                    Text(
                        c.name,
                        style = MaterialTheme.typography.labelSmall,
                        color = SwColors.Muted,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.tvFocus().clickable(onClick = onOpenConnection).padding(6.dp),
                    )
                }
                NavigationRailItem(
                    selected = current == SETTINGS,
                    onClick = { go(SETTINGS) },
                    icon = { Icon(Icons.Default.Settings, null) },
                    label = { Text("Settings") },
                )
                Spacer(Modifier.height(8.dp))
            }
            Box(Modifier.weight(1f)) { content() }
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            // Phone top row: the connection on the left, the viewer's menu on the right.
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(state.connection?.name ?: "", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                var menu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { menu = true }) { ViewerAvatar(viewer?.name ?: "?", viewer?.color, 28.dp) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Switch viewer") }, onClick = { menu = false; onSwitchViewer() })
                        DropdownMenuItem(
                            text = { Text(state.connection?.let { "Connection: ${it.name}" } ?: "IPTV connection") },
                            onClick = { menu = false; onOpenConnection() },
                        )
                        DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; go(SETTINGS) })
                    }
                }
            }
            Box(Modifier.weight(1f)) { content() }
            NavigationBar(containerColor = SwColors.Bg) {
                sections.forEach { s ->
                    NavigationBarItem(
                        selected = current == s.route,
                        onClick = { go(s.route) },
                        icon = { Icon(s.icon, null) },
                        label = { Text(s.label) },
                    )
                }
            }
        }
    }
}
