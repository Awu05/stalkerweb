package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.AccessGuard
import com.stalkerweb.android.data.api.PortalActionResponse
import com.stalkerweb.android.data.api.PortalConfigResponse
import com.stalkerweb.android.data.api.PortalConnectRequest
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.ProfilesResponse
import com.stalkerweb.android.data.api.SetActiveProfileRequest
import com.stalkerweb.android.data.api.SettingsResponse
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.api.StatusResponse
import com.stalkerweb.android.data.prefs.AppPrefs

/** The StalkerWeb server itself: address, access key, status, IPTV connections, settings. */
class ServerRepository(private val prefs: AppPrefs, private val apis: ApiProvider, private val guard: AccessGuard) {

    fun getServerUrl(): String? = prefs.serverUrl
    fun getAccessKey(): String? = prefs.accessKey

    /**
     * Saves the address and key (Setup tested them first) and rebuilds the
     * client; a key refused before may be tried again. A different server or key
     * forgets this device's viewer (the picker asks again), the cached channels
     * and logos (so the old server's don't flash), and the playback token with
     * the links that carry it — sent with a new key they'd count as wrong keys.
     */
    fun setServerUrl(url: String, accessKey: String? = null) {
        val normalized = url.trimEnd('/')
        val key = accessKey?.trim()?.ifEmpty { null }
        if (normalized != prefs.serverUrl || key != prefs.accessKey) {
            prefs.clearChannelCache()
            prefs.clearWatchedLogos()
            prefs.shareToken = null
            prefs.viewerId = null
        }
        guard.reset()
        prefs.serverUrl = normalized
        prefs.accessKey = key
        apis.rebuild()
    }

    /** Tests a candidate server without saving it, so a failed edit never leaves the app on a broken server. */
    suspend fun testServerUrl(url: String, accessKey: String? = null): StatusResponse =
        StalkerApi.create(url.trimEnd('/'), accessKey?.trim()?.ifEmpty { null }).getStatus()

    suspend fun testConnection(): StatusResponse = apis.get().getStatus()

    // ── Portal management ─────────────────────────────────────────────────────

    suspend fun disconnectPortal(): PortalActionResponse = apis.get().disconnectPortal()

    suspend fun reconnectPortal(): PortalActionResponse = apis.get().reconnectPortal()

    suspend fun getPortalConfig(): PortalConfigResponse? =
        runCatching { apis.get().getPortalConfig() }.getOrNull()

    // ── Portal profiles ─────────────────────────────────────────────────────────

    suspend fun getProfiles(): ProfilesResponse =
        runCatching { apis.get().getProfiles() }.getOrDefault(ProfilesResponse())

    suspend fun setActiveProfile(id: String?) =
        runCatching { apis.get().setActiveProfile(SetActiveProfileRequest(id)) }

    /** Connects using a saved profile and marks it active — mirrors the web
     *  Setup page's "connect from a saved profile" flow, which posts the whole
     *  profile. Passing only portal/mac/timezone/lang lets the backend
     *  substitute a generic STB identity, which portals that bind an account to
     *  a device reject — see PortalConnectRequest. */
    suspend fun connectProfile(profile: Profile): PortalActionResponse {
        val resp = apis.get().connectPortal(
            PortalConnectRequest(
                portal            = profile.portal,
                mac               = profile.mac,
                timezone          = profile.timezone,
                lang              = profile.lang,
                login             = profile.login,
                password          = profile.password,
                token             = profile.token,
                serialNumber      = profile.serialNumber,
                deviceId          = profile.deviceId,
                deviceId2         = profile.deviceId2,
                signature         = profile.signature,
                portalSignature   = profile.portalSignature,
                sendDeviceId      = profile.sendDeviceId,
                sendDeviceId2     = profile.sendDeviceId2,
                connectionTimeout = profile.connectionTimeout,
            )
        )
        if (resp.success) setActiveProfile(profile.id)
        return resp
    }

    /** The server's settings (VOD and guide switches, playback token), or null when unreachable. */
    suspend fun getSettings(): SettingsResponse? = runCatching {
        apis.get().getSettings().also { if (!prefs.accessKey.isNullOrBlank()) prefs.shareToken = it.accessShareToken }
    }.getOrNull()
}
