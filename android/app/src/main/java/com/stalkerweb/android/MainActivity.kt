package com.stalkerweb.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PictureInPictureParams
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.stalkerweb.android.crash.CrashReporter
import com.stalkerweb.android.data.api.AppEvent
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.data.update.UpdateManager
import com.stalkerweb.android.reminders.ReminderReceiver
import com.stalkerweb.android.ui.downloads.DownloadsScreen
import com.stalkerweb.android.ui.downloads.DownloadsViewModel
import com.stalkerweb.android.ui.guide.GuideScreen
import com.stalkerweb.android.ui.guide.GuideViewModel
import com.stalkerweb.android.ui.settings.SettingsScreen
import com.stalkerweb.android.ui.settings.SettingsViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.MutableStateFlow
import com.stalkerweb.android.ui.shell.AppShell
import com.stalkerweb.android.ui.shell.ShellViewModel
import com.stalkerweb.android.ui.viewers.ViewerPickerScreen
import com.stalkerweb.android.ui.channels.ChannelViewModel
import com.stalkerweb.android.ui.crash.CrashReportDialog
import com.stalkerweb.android.ui.player.PlayerViewModel
import com.stalkerweb.android.ui.setup.SetupScreen
import com.stalkerweb.android.ui.channels.ChannelScreen
import com.stalkerweb.android.ui.player.PlayerScreen
import com.stalkerweb.android.ui.theme.StalkerTheme
import androidx.compose.material3.MaterialTheme
import com.stalkerweb.android.ui.portal.PortalScreen
import com.stalkerweb.android.ui.portal.PortalViewModel
import com.stalkerweb.android.ui.update.UpdateDialog
import com.stalkerweb.android.ui.update.UpdateViewModel
import com.stalkerweb.android.ui.vod.VodPlayerScreen
import com.stalkerweb.android.ui.vod.VodPlayerViewModel
import com.stalkerweb.android.ui.vod.VodScreen
import com.stalkerweb.android.ui.vod.VodViewModel
import java.io.File

class MainActivity : ComponentActivity() {

    private var shouldEnterPipOnLeave = false
    private val isInPipMode = mutableStateOf(false)

    // File waiting to be installed after the user grants "unknown sources" permission.
    private var pendingInstallFile: File? = null

    // Kept so onResume can call refreshHistory() without capturing a stale reference.
    private var channelViewModel: ChannelViewModel? = null

    /** A channel a reminder notification asked to open (uniqueId to name). */
    private val pendingWatch = MutableStateFlow<Pair<String, String>?>(null)

    private fun takeWatchExtra(intent: Intent?) {
        val id = intent?.getStringExtra(ReminderReceiver.EXTRA_CHANNEL_ID) ?: return
        pendingWatch.value = id to intent.getStringExtra(ReminderReceiver.EXTRA_CHANNEL_NAME).orEmpty()
        intent.removeExtra(ReminderReceiver.EXTRA_CHANNEL_ID)
    }

    // A screen that must see the remote's keys wherever the focus is (RemoteKeys) sees them first.
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean =
        com.stalkerweb.android.ui.utils.RemoteKeys.handler?.invoke(event) == true || super.dispatchKeyEvent(event)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeWatchExtra(intent)
    }

    // Launcher for ACTION_MANAGE_UNKNOWN_APP_SOURCES. Fires install as soon as
    // the user grants permission; silently does nothing if they deny.
    private val unknownSourcesLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // Re-check permission after returning from Settings.
        val file = pendingInstallFile ?: return@registerForActivityResult
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            packageManager.canRequestPackageInstalls()
        ) {
            pendingInstallFile = null
            launchInstallIntent(file)
        }
        // If still not granted, pendingInstallFile is kept so the dialog's
        // "Install" button can try again.
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // PIP is a phone/tablet convenience — never enter it on TV.
        if (BuildConfig.IS_TV) return
        if (shouldEnterPipOnLeave && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .build()
            enterPictureInPictureMode(params)
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode)
        isInPipMode.value = isInPictureInPictureMode
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        createNotificationChannel()

        val container     = (application as StalkerWebApp).container
        val updateManager = UpdateManager(this)

        val isTV = BuildConfig.IS_TV
        if (savedInstanceState == null) takeWatchExtra(intent)

        setContent {
            StalkerTheme {
                val navController = rememberNavController()
                // Overscan padding keeps UI chrome clear of a TV's edge cutoff, but
                // it must not inset the video itself — the player already draws its
                // own edge-safe controls, so shrinking the video by 48dp on every
                // side just makes playback look letterboxed/non-fullscreen.
                val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route
                // 48dp was well past what TVs actually need for overscan safety
                // (~5% of screen edge, ~24-27dp) and ate a visible chunk of every
                // screen for no reason.
                val overscanPadding = if (isTV && currentRoute != Screen.Player.route && currentRoute != Screen.VodPlayer.route) 24.dp else 0.dp
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(overscanPadding)) {
                // Worked out once: recomputed, it flips to Shell after Setup and the rebuilt graph drops "Who's watching?".
                val startDest     = remember { if (container.server.getServerUrl() != null && !container.guard.blocked) Screen.Shell.route else Screen.Setup.route }

                val channelVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            ChannelViewModel(container.live, container.server, container.viewers, container.prefs) as T
                    }
                }
                val playerVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            PlayerViewModel(application, container.live, container.stats) as T
                    }
                }
                val updateVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            UpdateViewModel(updateManager) as T
                    }
                }
                val vodVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            VodViewModel(container.vod, container.watch, container.viewers, container.prefs, container.downloads) as T
                    }
                }
                val vodPlayerVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            VodPlayerViewModel(application, container.vod, container.watch, container.links, container.downloads, container.stats, container.prefs, container.viewers) as T
                    }
                }
                val portalVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            PortalViewModel(container.server) as T
                    }
                }

                val shellVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            ShellViewModel(container.server, container.viewers) as T
                    }
                }
                val guideVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            GuideViewModel(container.guide, container.live, container.reminders, container.viewers) as T
                    }
                }
                val downloadsVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            DownloadsViewModel(container.downloads) as T
                    }
                }
                val settingsVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            SettingsViewModel(container.settings, container.server, container.viewers, container.prefs) as T
                    }
                }

                val channelViewModel: ChannelViewModel = viewModel<ChannelViewModel>(factory = channelVmFactory).also { this@MainActivity.channelViewModel = it }
                val playerViewModel:  PlayerViewModel  = viewModel<PlayerViewModel>(factory = playerVmFactory)
                val updateViewModel:  UpdateViewModel  = viewModel<UpdateViewModel>(factory = updateVmFactory)
                val vodViewModel:     VodViewModel     = viewModel<VodViewModel>(factory = vodVmFactory)

                val setupScope = rememberCoroutineScope()
                fun toShell() = navController.navigate(Screen.Shell.route) { popUpTo(0) { inclusive = true } }
                fun toPicker(required: Boolean) = navController.navigate(Screen.Viewers.go(required)) {
                    if (required) popUpTo(0) { inclusive = true }
                }

                // Startup: who's watching first (as on the web), then whether a portal is connected.
                LaunchedEffect(Unit) {
                    if (container.server.getServerUrl() == null || container.guard.blocked) return@LaunchedEffect
                    if (container.viewers.startupChoice().needsPicker) { toPicker(required = true); return@LaunchedEffect }
                    val status = runCatching { container.server.testConnection() }.getOrNull()
                    if (status?.connected == false) navController.navigate(Screen.Portal.route)
                }

                // A reminder came due while the app is open: say so here too, with Watch.
                var dueReminder by remember { mutableStateOf<com.stalkerweb.android.data.repo.Reminder?>(null) }
                LaunchedEffect(Unit) { container.reminders.due.collect { dueReminder = it } }
                dueReminder?.let { r ->
                    androidx.compose.material3.AlertDialog(
                        onDismissRequest = { dueReminder = null },
                        title = { androidx.compose.material3.Text("Starting now: ${r.title}") },
                        text = { androidx.compose.material3.Text(r.channelName) },
                        confirmButton = { androidx.compose.material3.Button(onClick = { dueReminder = null; pendingWatch.value = r.channelId to r.channelName }) { androidx.compose.material3.Text("Watch") } },
                        dismissButton = { androidx.compose.material3.TextButton(onClick = { dueReminder = null }) { androidx.compose.material3.Text("Later") } },
                    )
                }

                // A reminder's notification: play its channel once the app is past setup and the picker.
                val watch by pendingWatch.collectAsStateWithLifecycle()
                LaunchedEffect(watch, currentRoute) {
                    val (id, name) = watch ?: return@LaunchedEffect
                    if (currentRoute != Screen.Shell.route && currentRoute != Screen.Player.route) return@LaunchedEffect
                    pendingWatch.value = null
                    navController.navigate(Screen.Player.go(id, name))
                }

                // Problems any request can hit: a deleted viewer, or the access key no longer accepted.
                LaunchedEffect(Unit) {
                    container.events.events.collect { event ->
                        val route = navController.currentBackStackEntry?.destination?.route
                        when (event) {
                            is AppEvent.ViewerGone -> if (route != Screen.Viewers.route) {
                                container.viewers.forget()
                                toPicker(required = true)
                            }
                            is AppEvent.AccessProblem -> if (route != Screen.Setup.route) {
                                // Leave the shell at once: every request carries the key, and each
                                // wrong one counts toward the server's lockout.
                                navController.navigate(Screen.Setup.go(event.message)) { popUpTo(0) { inclusive = true } }
                            }
                        }
                    }
                }

                // Collect install events from the ViewModel and handle them here
                // where we have a real Activity context and the result launcher.
                LaunchedEffect(updateViewModel) {
                    updateViewModel.installEvent.collect { file ->
                        handleInstall(file)
                    }
                }

                LaunchedEffect(Unit) { updateViewModel.check() }
                UpdateDialog(updateViewModel)

                // Surface a stack trace recorded by the previous run. Read once
                // on first composition so dismissing it doesn't bring it back.
                var crashReport by remember { mutableStateOf(CrashReporter.pendingReport(this@MainActivity)) }
                crashReport?.let { report ->
                    CrashReportDialog(
                        report    = report,
                        onDismiss = {
                            CrashReporter.clear(this@MainActivity)
                            crashReport = null
                        },
                    )
                }

                NavHost(navController = navController, startDestination = startDest) {

                    composable(
                        Screen.Setup.route,
                        arguments = listOf(navArgument("message") { type = NavType.StringType; defaultValue = "" }),
                    ) { backStack ->
                        // Reachable on first run, from Settings, and after an access-key problem.
                        val fromApp = navController.previousBackStackEntry != null
                        SetupScreen(
                            server       = container.server,
                            startMessage = backStack.arguments?.getString("message")?.takeIf { it.isNotBlank() } ?: container.guard.message,
                            onConnected  = {
                                channelViewModel.load(reset = true)
                                // A new server or key forgot the viewer (ServerRepository.setServerUrl):
                                // ask again — unless the server has no viewers to ask about (an older one).
                                setupScope.launch {
                                    if (container.viewers.startupChoice().needsPicker) toPicker(required = true) else toShell()
                                }
                            },
                            onBack = if (fromApp) ({ navController.popBackStack() }) else null,
                        )
                    }

                    composable(
                        Screen.Viewers.route,
                        arguments = listOf(navArgument("required") { type = NavType.BoolType; defaultValue = false }),
                    ) { backStack ->
                        val required = backStack.arguments?.getBoolean("required") ?: false
                        ViewerPickerScreen(
                            viewers   = container.viewers,
                            required  = required,
                            onChosen  = { toShell() },
                            onClose   = { navController.popBackStack() },
                            onExitApp = { finish() },
                        )
                    }

                    composable(Screen.Shell.route) {
                        val shellViewModel: ShellViewModel = viewModel(factory = shellVmFactory)
                        val reminders by container.reminders.list.collectAsStateWithLifecycle()
                        AppShell(
                            vm = shellViewModel,
                            channels = {
                                ChannelScreen(
                                    viewModel = channelViewModel,
                                    onSelectChannel = { channel -> navController.navigate(Screen.Player.go(channel.uniqueId, channel.name)) },
                                    onOpenPortal = { navController.navigate(Screen.Portal.route) },
                                )
                            },
                            vod = {
                                VodScreen(
                                    viewModel = vodViewModel,
                                    watch = container.watch,
                                    onPlay = { params -> navController.navigate(Screen.VodPlayer.go(params)) },
                                )
                            },
                            guide = {
                                GuideScreen(
                                    viewModel = viewModel(factory = guideVmFactory),
                                    onWatch = { channel -> navController.navigate(Screen.Player.go(channel.uniqueId, channel.name)) },
                                )
                            },
                            downloads = { DownloadsScreen(viewModel = viewModel(factory = downloadsVmFactory)) },
                            settings = {
                                SettingsScreen(
                                    viewModel = viewModel(factory = settingsVmFactory),
                                    updates = updateViewModel,
                                    serverUrl = container.server.getServerUrl(),
                                    onOpenServer = { navController.navigate(Screen.Setup.go()) },
                                    onOwnViewerDeleted = { toPicker(required = true) },
                                )
                            },
                            reminders = reminders,
                            onCancelReminder = container.reminders::remove,
                            onSwitchViewer   = { toPicker(required = false) },
                            onOpenConnection = { navController.navigate(Screen.Portal.route) },
                        )
                    }

                    composable(Screen.Portal.route) {
                        val portalViewModel: PortalViewModel = viewModel(factory = portalVmFactory)
                        PortalScreen(
                            viewModel = portalViewModel,
                            onBack    = {
                                // Connecting a portal doesn't touch ChannelViewModel,
                                // which is created once and never reloaded on
                                // navigation — so without this the user returns to
                                // the same "Connect a portal to load channels" empty
                                // state they just came here to fix.
                                // …and VOD and the Guide too, which also show the old portal's.
                                container.viewers.sectionsChanged()
                                if (!navController.popBackStack()) toShell()
                            },
                        )
                    }

                    composable(
                        route = Screen.VodPlayer.route,
                        arguments = listOf(navArgument("params") { type = NavType.StringType; defaultValue = "" }),
                    ) { backStack ->
                        // Scoped to this destination so each opened title gets a fresh VM.
                        val vodPlayerViewModel: VodPlayerViewModel = viewModel(factory = vodPlayerVmFactory)
                        VodPlayerScreen(
                            params    = PlayerParams.parse(backStack.arguments?.getString("params") ?: ""),
                            viewModel = vodPlayerViewModel,
                            onBack    = { navController.popBackStack() },
                        )
                    }

                    composable(
                        route = Screen.Player.route,
                        arguments = listOf(
                            navArgument("channelId")   { type = NavType.StringType },
                            navArgument("channelName") { type = NavType.StringType },
                        ),
                    ) { backStack ->
                        val channelId   = backStack.arguments?.getString("channelId")   ?: ""
                        val channelName = backStack.arguments?.getString("channelName") ?: ""
                        PlayerScreen(
                            channelId        = channelId,
                            channelName      = channelName,
                            viewModel        = playerViewModel,
                            isInPipMode      = isInPipMode.value,
                            onSetPipEnabled  = { shouldEnterPipOnLeave = it },
                            onBack           = { navController.popBackStack() },
                        )
                    }
                }
                } // end overscan Box
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Refresh so "Continue watching" shows channels added during the player session
        channelViewModel?.refreshHistory()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                UpdateManager.CHANNEL_ID,
                UpdateManager.CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Update download progress" }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun handleInstall(file: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            pendingInstallFile = file
            unknownSourcesLauncher.launch(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName")
                )
            )
            return
        }
        launchInstallIntent(file)
    }

    private fun launchInstallIntent(file: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        )
    }
}
