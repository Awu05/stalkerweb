package com.stalkerweb.android

import android.app.Application
import com.stalkerweb.android.crash.CrashReporter
import com.stalkerweb.android.data.repo.AppContainer

/**
 * Exists so the crash handler is installed before anything else runs — a crash
 * during Activity startup, or on a background thread before any UI exists,
 * would be missed if this were wired up inside MainActivity.
 */
class StalkerWebApp : Application() {
    /** The data layer, built once for the whole app. */
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        CrashReporter.install(this)
        container = AppContainer(this)
    }
}
