package com.stalkerweb.android.solo

import androidx.activity.ComponentActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** The remote apps keep downloads on their server: nothing to save here. */
object DownloadPublisher {
    @Suppress("UNUSED_PARAMETER")
    fun attach(activity: ComponentActivity) {}

    /** Never: nothing is saved to this device's Downloads folder. */
    val storageDenied: StateFlow<Boolean> = MutableStateFlow(false)
}
