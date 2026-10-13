package com.stalkerweb.android

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.stalkerweb.android.crash.CrashReporter
import com.stalkerweb.android.data.repo.AppContainer

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
        container = AppContainer(this)
    }

    // Images (logos, posters) load through the app's own HTTP client: it sends
    // the access key to the server — so image links needn't carry a token — and
    // its access guard keeps a refused key from being retried by every image.
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this).okHttpClient { container.httpClient }.build()
}
