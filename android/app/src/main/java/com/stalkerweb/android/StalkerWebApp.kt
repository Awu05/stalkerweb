package com.stalkerweb.android

import android.app.Application
import android.os.Build
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.stalkerweb.android.crash.CrashReporter
import com.stalkerweb.android.data.repo.AppContainer
import com.stalkerweb.android.solo.SoloServer
import java.io.File

/**
 * Exists so the crash handler is installed before anything else runs — a crash
 * during Activity startup, or on a background thread before any UI exists,
 * would be missed if this were wired up inside MainActivity.
 */
class StalkerWebApp : Application(), ImageLoaderFactory {
    /** The data layer, built once for the whole app. */
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        CrashReporter.install(this)
        // Solo's server has a process of its own (":node"), which runs this too:
        // it needs none of the app's data layer, so none is built there.
        if (!isMainProcess()) return
        container = AppContainer(this)
        // Solo: start the server inside the app (a no-op in the remote apps).
        SoloServer.boot(this, container)
    }

    private fun isMainProcess(): Boolean {
        val name = if (Build.VERSION.SDK_INT >= 28) getProcessName()
            else runCatching { File("/proc/self/cmdline").readText().substringBefore(Char(0)).trim() }.getOrNull()
        return name == null || name == packageName
    }

    // Images (logos, posters) load through the app's own HTTP client: it sends
    // the access key to the server — so image links needn't carry a token — and
    // its access guard keeps a refused key from being retried by every image.
    override fun newImageLoader(): ImageLoader =
        if (::container.isInitialized) ImageLoader.Builder(this).okHttpClient { container.httpClient }.build()
        else ImageLoader(this)   // not the app's process: no images are shown there
}
