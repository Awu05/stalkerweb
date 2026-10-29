package com.stalkerweb.android.solo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import androidx.core.content.ContextCompat
import com.stalkerweb.android.data.repo.AppContainer
import com.stalkerweb.android.data.repo.LanKind
import com.stalkerweb.android.data.repo.LanNetwork
import com.stalkerweb.android.data.repo.isTetherInterface
import com.stalkerweb.android.data.repo.lanHostOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap

/**
 * Tells Solo's server the device's Wi-Fi address (PUT /api/solo/network), for
 * cast links: a TV fetches the stream from there, and the server can't tell
 * which of the device's addresses the TV reaches. Sent when Wi-Fi comes up or
 * changes, and { lanHost: null } when it's gone — then the server marks cast
 * links unreachable and the Cast button says "Casting needs Wi-Fi". Ethernet
 * counts too (a TV box is often wired), and so does the phone's own hotspot
 * (a TV joined to it); with more than one, Wi-Fi first, then Ethernet, then
 * the hotspot (lanHostOf), whichever came up first. The server keeps it in
 * memory only, so it's sent again whenever the server is (back) up: [resend].
 */
object CastNetwork {
    private const val TAG = "SoloServer"
    private val JSON = "application/json".toMediaType()
    // Sent when the hotspot or tethering is turned on or off (long-standing, though not in the SDK).
    private const val TETHER_STATE_CHANGED = "android.net.conn.TETHER_STATE_CHANGED"

    // The addresses of each Wi-Fi or Ethernet network the device is on, and what it is.
    private val networks = ConcurrentHashMap<Network, List<String>>()
    private val kinds = ConcurrentHashMap<Network, LanKind>()
    @Volatile private var container: AppContainer? = null
    @Volatile private var cm: ConnectivityManager? = null
    // What the server was last told; NOT_SENT until it has been.
    @Volatile private var sent: Any? = NOT_SENT
    private object NOT_SENT

    // One at a time, in order: the last one sent is the latest address.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))

    fun start(context: Context, container: AppContainer) {
        this.container = container
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        this.cm = cm
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            // A Wi-Fi without internet (just the TV and the phone) still casts.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { cm.registerNetworkCallback(request, callback) }
            .onFailure { Log.w(TAG, "can't follow the Wi-Fi, so casting stays off (${it.javaClass.simpleName})") }
        runCatching {
            ContextCompat.registerReceiver(context, tethering, IntentFilter(TETHER_STATE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        }.onFailure { Log.i(TAG, "can't follow the hotspot (${it.javaClass.simpleName})") }
    }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            kinds[network] = kindOf(caps)
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            networks[network] = linkProperties.linkAddresses.mapNotNull { it.address.hostAddress }
            send(force = false)
        }

        override fun onLost(network: Network) {
            networks.remove(network)
            kinds.remove(network)
            send(force = false)
        }
    }

    private val tethering = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = send(force = false)
    }

    private fun kindOf(caps: NetworkCapabilities): LanKind =
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) LanKind.Wifi else LanKind.Ethernet

    // What a network is, as last heard — asked for when its capabilities haven't come yet.
    private fun kind(network: Network): LanKind =
        kinds[network] ?: cm?.getNetworkCapabilities(network)?.let(::kindOf) ?: LanKind.Wifi

    /** The server is (back) up: tell it again, it forgets on a restart. */
    fun resend() = send(force = true)

    private fun send(force: Boolean) {
        scope.launch {
            // Each network in a fixed order (its handle), then the hotspot's own addresses.
            val known = networks.entries.sortedBy { it.key.networkHandle }.map { (n, a) -> LanNetwork(kind(n), a) }
            val taken = known.flatMap { it.addresses }.toSet()
            val host = lanHostOf(known + LanNetwork(LanKind.Hotspot, hotspotAddresses() - taken))
            if (!force && sent == host) return@launch
            if (put(host)) sent = host
        }
    }

    // The IPv4 addresses on interfaces the device shares its connection on (a hotspot), in name order.
    private fun hotspotAddresses(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback && isTetherInterface(it.name) }
            .sortedBy { it.name }
            .flatMap { i -> i.inetAddresses.toList().filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress } }
    }.getOrDefault(emptyList())

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
