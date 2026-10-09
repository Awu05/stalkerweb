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
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.repository.ChannelRepository
import com.stalkerweb.android.data.update.UpdateManager
import com.stalkerweb.android.ui.channels.ChannelViewModel
import com.stalkerweb.android.ui.crash.CrashReportDialog
import com.stalkerweb.android.ui.player.PlayerViewModel
import com.stalkerweb.android.ui.setup.SetupScreen
import com.stalkerweb.android.ui.channels.ChannelScreen
import com.stalkerweb.android.ui.player.PlayerScreen
import com.stalkerweb.android.ui.theme.StalkerTheme
import com.stalkerweb.android.ui.theme.appBackgroundBrush
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

        val prefs         = AppPrefs(this)
        val repository    = ChannelRepository(prefs).also { it.initFromPrefs() }
        val updateManager = UpdateManager(this)

        val isTV = BuildConfig.IS_TV

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
                val overscanPadding = if (isTV && currentRoute != Screen.Player.route) 24.dp else 0.dp
                Box(Modifier.fillMaxSize().background(appBackgroundBrush()).padding(overscanPadding)) {
                val startDest     = if (repository.getServerUrl() != null) Screen.Channels.route
                                    else Screen.Setup.route

                val channelVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            ChannelViewModel(repository) as T
                    }
                }
                val playerVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            PlayerViewModel(application, repository) as T
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
                            VodViewModel(repository) as T
                    }
                }
                val vodPlayerVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            VodPlayerViewModel(application, repository) as T
                    }
                }
                val portalVmFactory = remember {
                    object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            PortalViewModel(repository) as T
                    }
                }

                val channelViewModel: ChannelViewModel = viewModel<ChannelViewModel>(factory = channelVmFactory).also { this@MainActivity.channelViewModel = it }
                val playerViewModel:  PlayerViewModel  = viewModel<PlayerViewModel>(factory = playerVmFactory)
                val updateViewModel:  UpdateViewModel  = viewModel<UpdateViewModel>(factory = updateVmFactory)
                val vodViewModel:     VodViewModel     = viewModel<VodViewModel>(factory = vodVmFactory)

                // Whether the VOD section is enabled (controlled from the web Settings page).
                var vodEnabled by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    runCatching { repository.isVodEnabled() }.onSuccess { vodEnabled = it }
                }

                // A saved server URL doesn't mean the portal itself is connected —
                // it may have never been set up, or dropped since. Check once on
                // launch and send the user straight to the Portal screen instead of
                // dumping them on a dead Channels list full of 503 errors.
                LaunchedEffect(Unit) {
                    if (repository.getServerUrl() != null) {
                        val status = runCatching { repository.testConnection() }.getOrNull()
                        if (status?.connected != true) {
                            navController.navigate(Screen.Portal.route)
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

                    composable(Screen.Setup.route) {
                        // Reachable two ways: first-run (start destination, nothing
                        // behind it) and from the channel list's settings button.
                        val fromApp = navController.previousBackStackEntry != null
                        SetupScreen(
                            repository  = repository,
                            onConnected = {
                                channelViewModel.load(reset = true)
                                if (fromApp) {
                                    navController.popBackStack()
                                } else {
                                    navController.navigate(Screen.Channels.route) {
                                        popUpTo(Screen.Setup.route) { inclusive = true }
                                    }
                                }
                            },
                            onBack = if (fromApp) ({ navController.popBackStack() }) else null,
                        )
                    }

                    composable(Screen.Channels.route) {
                        ChannelScreen(
                            viewModel       = channelViewModel,
                            onSelectChannel = { channel ->
                                navController.navigate(Screen.Player.go(channel.uniqueId, channel.name))
                            },
                            vodEnabled      = vodEnabled,
                            onOpenVod       = { navController.navigate(Screen.Vod.route) },
                            onOpenSettings  = { navController.navigate(Screen.Setup.route) },
                            onOpenPortal    = { navController.navigate(Screen.Portal.route) },
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
                                channelViewModel.load()
                                navController.popBackStack()
                            },
                        )
                    }

                    composable(Screen.Vod.route) {
                        VodScreen(
                            viewModel   = vodViewModel,
                            onBack      = { navController.popBackStack() },
                            onPlayMovie = { item ->
                                navController.navigate(
                                    Screen.VodPlayer.go(videoId = item.id, cmd = item.cmd, title = item.name)
                                )
                            },
                            onPlayEpisode = { show, season, episodeId, seriesNumber, title ->
                                navController.navigate(
                                    Screen.VodPlayer.go(
                                        videoId   = show.id,
                                        series    = seriesNumber,
                                        seasonId  = season.id,
                                        episodeId = episodeId,
                                        title     = "${show.name} · $title",
                                    )
                                )
                            },
                        )
                    }

                    composable(
                        route = Screen.VodPlayer.route,
                        arguments = listOf(
                            navArgument("videoId")   { type = NavType.StringType; defaultValue = "" },
                            navArgument("cmd")       { type = NavType.StringType; defaultValue = "" },
                            navArgument("series")    { type = NavType.StringType; defaultValue = "" },
                            navArgument("seasonId")  { type = NavType.StringType; defaultValue = "" },
                            navArgument("episodeId") { type = NavType.StringType; defaultValue = "" },
                            navArgument("title")     { type = NavType.StringType; defaultValue = "" },
                        ),
                    ) { backStack ->
                        val a = backStack.arguments
                        // Scoped to this destination so each opened video gets a fresh VM.
                        val vodPlayerViewModel: VodPlayerViewModel = viewModel(factory = vodPlayerVmFactory)
                        VodPlayerScreen(
                            videoId   = a?.getString("videoId") ?: "",
                            cmd       = a?.getString("cmd") ?: "",
                            series    = a?.getString("series") ?: "",
                            seasonId  = a?.getString("seasonId") ?: "",
                            episodeId = a?.getString("episodeId") ?: "",
                            title     = a?.getString("title") ?: "",
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
