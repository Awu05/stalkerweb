package com.stalkerweb.android.solo

import android.app.Application
import androidx.activity.ComponentActivity
import com.stalkerweb.android.data.repo.AppContainer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.HttpUrl
import okhttp3.OkHttpClient

/**
 * The remote apps talk to a StalkerWeb server elsewhere: there's none to start
 * here, so each of these does nothing — the shared code calls them all the same.
 */
object SoloServer {
    @Suppress("UNUSED_PARAMETER")
    fun boot(app: Application, container: AppContainer) {}

    @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
    suspend fun awaitReady(client: OkHttpClient, timeoutMs: Long = 20_000): Boolean = true

    @Suppress("UNUSED_PARAMETER")
    fun hold(reason: String) {}

    @Suppress("UNUSED_PARAMETER")
    fun release(reason: String) {}

    fun onConnectionFailed() {}

    fun restart() {}

    @Suppress("UNUSED_PARAMETER")
    fun attach(activity: ComponentActivity) {}

    /** The server is the person's own, set up by them: the key goes to it as always. */
    @Suppress("UNUSED_PARAMETER")
    fun keyAllowed(url: HttpUrl): Boolean = true

    /** No server kept running here, so no notification to ask for. */
    val notificationAsk: StateFlow<Boolean> = MutableStateFlow(false)

    fun notificationAsked() {}
}
