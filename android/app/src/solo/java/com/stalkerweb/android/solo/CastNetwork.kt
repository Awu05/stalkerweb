package com.stalkerweb.android.solo

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import com.stalkerweb.android.data.repo.AppContainer
import com.stalkerweb.android.data.repo.lanHostOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.ConcurrentHashMap

/**
 * Tells Solo's server the device's Wi-Fi address (PUT /api/solo/network), for
 * cast links: a TV fetches the stream from there, and the server can't tell
 * which of the device's addresses the TV reaches. Sent when Wi-Fi comes up or
 * changes, and { lanHost: null } when it's gone — then the server marks cast
 * links unreachable and the Cast button says "Casting needs Wi-Fi". Ethernet
 * counts too (a TV box is often wired). The server keeps it in memory only, so
 * it's sent again whenever the server is (back) up: [resend].
 */
object CastNetwork {
    private const val TAG = "SoloServer"
    private val JSON = "application/json".toMediaType()

    // The addresses of each Wi-Fi or Ethernet network the device is on.
    private val networks = ConcurrentHashMap<Network, List<String>>()
    @Volatile private var container: AppContainer? = null
    // What the server was last told; NOT_SENT until it has been.
    @Volatile private var sent: Any? = NOT_SENT
    private object NOT_SENT

    // One at a time, in order: the last one sent is the latest address.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))

    fun start(context: Context, container: AppContainer) {
        this.container = container
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            // A Wi-Fi without internet (just the TV and the phone) still casts.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(request, callback) }
            .onFailure { Log.w(TAG, "can't follow the Wi-Fi, so casting stays off (${it.javaClass.simpleName})") }
    }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            networks[network] = linkProperties.linkAddresses.mapNotNull { it.address.hostAddress }
            send(force = false)
        }

        override fun onLost(network: Network) {
            networks.remove(network)
            send(force = false)
        }
    }

    /** The server is (back) up: tell it again, it forgets on a restart. */
    fun resend() = send(force = true)

    private fun send(force: Boolean) {
        scope.launch {
            val host = lanHostOf(networks.values.flatten())
            if (!force && sent == host) return@launch
            if (put(host)) sent = host
        }
    }

    // False when the server didn't take it (not up yet): it's sent again once it is.
    private fun put(host: String?): Boolean {
        val c = container ?: return false
        val url = c.prefs.serverUrl ?: return false
        // host is a plain IPv4 (lanHostOf), nothing to escape.
        val body = (if (host == null) """{"lanHost":null}""" else """{"lanHost":"$host"}""").toRequestBody(JSON)
        val request = Request.Builder().url("$url/api/solo/network").put(body).build()
        return runCatching { c.httpClient.newCall(request).execute().use { it.isSuccessful } }.getOrDefault(false)
    }
}
