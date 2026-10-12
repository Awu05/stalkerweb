package com.stalkerweb.android.data.api

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** Problems any request can run into that the whole app must react to (MainActivity). */
sealed class AppEvent {
    /** This device's viewer was deleted: ask "Who's watching?" again. */
    object ViewerGone : AppEvent()
    /** The access key stopped working, or this address is locked out: back to Setup. */
    data class AccessProblem(val message: String) : AppEvent()
}

fun appEventFor(code: Int, body: String?): AppEvent? = when (val e = apiErrorFor(code, body)) {
    is ApiError.ViewerGone -> AppEvent.ViewerGone
    is ApiError.AccessDenied, is ApiError.LockedOut -> AppEvent.AccessProblem(e.message ?: "")
    else -> null
}

class AppEvents {
    private val _events = MutableSharedFlow<AppEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<AppEvent> = _events.asSharedFlow()
    fun emit(event: AppEvent) { _events.tryEmit(event) }
}
