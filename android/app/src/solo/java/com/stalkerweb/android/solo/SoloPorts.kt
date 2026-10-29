package com.stalkerweb.android.solo

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/** The Solo server's two ports: the app's (127.0.0.1) and the cast listener's (the Wi-Fi). */
object SoloPorts {
    /**
     * The ports to start the server on. The [saved] ones are kept while they're
     * free. One that's taken (another app holds it while the server is down)
     * is replaced: the server can't listen on it, and would only stop and be
     * started again on it, over and over. With none saved, both are picked.
     * The two are never the same port.
     */
    fun choose(saved: Pair<Int, Int>?, isFree: (Int) -> Boolean, pickFree: () -> Int): Pair<Int, Int> {
        fun usable(p: Int?) = p != null && p in 1..65535 && isFree(p)
        val port = saved?.first?.takeIf { usable(it) }
        val castPort = saved?.second?.takeIf { usable(it) && it != port }
        val p = port ?: pickOther(castPort, pickFree)
        val c = castPort ?: pickOther(p, pickFree)
        return p to c
    }

    private fun pickOther(other: Int?, pickFree: () -> Int): Int {
        repeat(10) { pickFree().let { if (it != other) return it } }
        throw IOException("no free port")
    }

    /** A port nothing is listening on right now. */
    fun freePort(): Int = ServerSocket(0).use { it.localPort }

    /**
     * Whether the server could listen on [port]: on 127.0.0.1 (the app's
     * listener) and on every address (the cast listener's).
     */
    fun isFree(port: Int): Boolean =
        canBind(InetSocketAddress(InetAddress.getLoopbackAddress(), port)) && canBind(InetSocketAddress(port))

    private fun canBind(address: InetSocketAddress): Boolean = try {
        // As Node does (SO_REUSEADDR): the last run's closed connections don't count as taken.
        ServerSocket().use { it.reuseAddress = true; it.bind(address); true }
    } catch (e: IOException) {
        false
    }
}
