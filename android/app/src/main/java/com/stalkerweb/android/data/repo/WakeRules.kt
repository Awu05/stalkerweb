package com.stalkerweb.android.data.repo

// The server drops its portal session after a while with nothing playing (the
// idle timeout, 30 min by default). Opening the app, or coming back to it
// after a while, asks the server to reconnect to the last portal
// (GET /api/auth/status?wake=1 — ServerRepository.testConnection(wake)). The
// screens' own status checks never do, or the session would never go idle.

/** Away from the app this long: coming back asks the server to reconnect. */
const val WAKE_AFTER_HIDDEN_MS = 5 * 60_000L

/** Whether coming back, away since [hiddenAt] (ms, or null), should wake the server. */
fun wakesOnReturn(hiddenAt: Long?, now: Long): Boolean = hiddenAt != null && now - hiddenAt >= WAKE_AFTER_HIDDEN_MS
