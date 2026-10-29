package com.stalkerweb.android.solo

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * The Solo server's port: the app's, on 127.0.0.1. The cast listener (on the
 * Wi-Fi) takes a free port of its own each time it starts — the server's
 * choice, not saved.
 */
object SoloPorts {
    /**
     * The port to start the server on. The [saved] one is kept while it's
     * free. One that's taken (another app holds it while the server is down)
     * is replaced: the server can't listen on it, and would only stop and be
     * started again on it, over and over. With none saved, one is picked.
     */
    fun choose(saved: Int?, isFree: (Int) -> Boolean, pickFree: () -> Int): Int =
        saved?.takeIf { it in 1..65535 && isFree(it) } ?: pickFree()

    /** A port nothing is listening on right now. */
    fun freePort(): Int = ServerSocket(0).use { it.localPort }

    /** Whether the server could listen on [port], on 127.0.0.1. */
    fun isFree(port: Int): Boolean = try {
        // As Node does (SO_REUSEADDR): the last run's closed connections don't count as taken.
        ServerSocket().use { it.reuseAddress = true; it.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), port)); true }
    } catch (e: IOException) {
        false
    }
}
