package com.stalkerweb.android.solo

import android.app.Application
import com.stalkerweb.android.data.repo.AppContainer
import okhttp3.OkHttpClient

/** The remote apps talk to a StalkerWeb server elsewhere: there's none to start here. */
object SoloServer {
    @Suppress("UNUSED_PARAMETER")
    fun boot(app: Application, container: AppContainer) {}

    @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
    suspend fun awaitReady(client: OkHttpClient, timeoutMs: Long = 20_000): Boolean = true
}
