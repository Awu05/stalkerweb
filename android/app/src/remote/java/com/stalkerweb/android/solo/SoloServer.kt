package com.stalkerweb.android.solo

import android.app.Application
import androidx.activity.ComponentActivity
import com.stalkerweb.android.data.repo.AppContainer
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
}
