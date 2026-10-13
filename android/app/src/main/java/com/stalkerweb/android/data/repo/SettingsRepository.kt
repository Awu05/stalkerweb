package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.CreateViewerRequest
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.LogoOverrideRequest
import com.stalkerweb.android.data.api.LogosInfo
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.SettingsResponse
import com.stalkerweb.android.data.api.SettingsUpdate
import com.stalkerweb.android.data.api.ViewerFiltersRequest
import com.stalkerweb.android.data.api.ViewerUpdate
import com.stalkerweb.android.data.api.WordRequest
import com.stalkerweb.android.data.prefs.AppPrefs

/** What the Settings tabs read and change on the server. */
class SettingsRepository(private val apis: ApiProvider, private val prefs: AppPrefs) {
    suspend fun settings(): SettingsResponse = apis.get().getSettings().also { prefs.keepShareToken(it.accessShareToken) }
    suspend fun save(update: SettingsUpdate) = apis.get().saveSettings(update)

    // Viewers
    suspend fun renameViewer(id: String, name: String) = apis.get().updateViewer(id, ViewerUpdate(name = name.trim()))
    suspend fun recolorViewer(id: String, color: String) = apis.get().updateViewer(id, ViewerUpdate(color = color))
    suspend fun deleteViewer(id: String) = apis.get().deleteViewer(id)
    /** Adds a viewer without switching this device to it (as the web's Viewers card). */
    suspend fun createViewer(name: String) = apis.get().createViewer(CreateViewerRequest(name.trim()))
    suspend fun saveFilters(f: ViewerFiltersRequest) = apis.get().saveMyFilters(f)
    /** Every channel genre (unfiltered), for the viewer's checklist. */
    suspend fun allGenres(): List<Group> = apis.get().getGroups().groups.filter { it.id != "*" }
    /** The portal's own movie or series categories, for the checklist. */
    suspend fun portalCategories(type: String): List<String> =
        apis.get().getPortalVodCategories(type).categories.map { it.title }.filter { !it.trim().equals("all", true) }.distinct()

    // IPTV connections
    suspend fun createProfile(p: Profile) = apis.get().createProfile(p)
    suspend fun updateProfile(p: Profile) = apis.get().updateProfile(p.id, p)
    suspend fun deleteProfile(id: String) = apis.get().deleteProfile(id)

    // Logos
    suspend fun logos(): LogosInfo = apis.get().getLogos()
    suspend fun refreshLogos() = apis.get().refreshLogos()
    suspend fun addOverride(name: String, url: String) = apis.get().setLogoOverride(LogoOverrideRequest(name.trim(), url.trim()))
    suspend fun removeOverride(name: String) = apis.get().deleteLogoOverride(name)
    suspend fun stripWords(): List<String> = apis.get().getStripWords().stripWords
    suspend fun addStripWord(w: String) = apis.get().addStripWord(WordRequest(w.trim()))
    suspend fun removeStripWord(w: String) = apis.get().deleteStripWord(w)
}
