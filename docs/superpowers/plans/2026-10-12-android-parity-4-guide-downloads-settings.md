# Android Parity Part 4: Guide, Downloads and Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the shell's Guide, Downloads and Settings sections to match the web, with:
- reminders as notifications;
- download buttons back in VOD;
- the Settings tabs Viewers, Connection, Links, Playback and Logos.

**Architecture:**
- **Pure rules** in `data/repo/Part4Rules.kt`, unit-tested: guide maths, the server-event parser, byte formatting, the links, filter lists and reminder rules.
- **New repositories:**
  - `GuideRepository`
  - `DownloadsRepository`, whose live list comes from the server-event stream over the app's guarded OkHttp client
  - `SettingsRepository`
  - `RemindersRepository`, with `AlarmManager` scheduling and a `ReminderReceiver`
- **UI** in `ui/guide`, `ui/downloads` and `ui/settings`, wired into `AppShell`.

**Tech Stack:** Kotlin, Compose (Material 3), Retrofit and Moshi, OkHttp, AndroidX core (`NotificationCompat`), `AlarmManager`. JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-12-android-parity-4-guide-downloads-settings-design.md`

## Global Constraints

- **Branch** `feat/android-guide-settings`, stacked on `feat/android-live`; the PR goes into main. CI compiles and tests, as before.
- **Guide:**
  - 6 dp per minute; rows 64 dp tall; the channel column 180 dp wide.
  - The window runs from now − 30 min to now + 24 h.
  - The guide is cached for 10 min.
- **Reminders:** the alarm fires at `startTime − 60 s`; notification channel `stalkerweb_reminders`; the intent extras are `channelId` and `channelName`.
- **Downloads:** the server-event stream at `/api/downloads/events`, falling back to polling every 3 s.
- **Playback choices:**
  - live buffer: 0, 5, 10, 15, 30 or 60 s;
  - idle disconnect: 0, 15, 30, 60, 120 or 240 min.
- **Viewer colours:** `#5b8def`, `#e5484d`, `#30a46c`, `#f5a524`, `#8e4ec6`, `#12a594`, `#e93d82`, `#978365`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A reminder set for a programme already started or past** is dropped, not scheduled. Pinned by `ReminderRules` tests.
2. **Links built with and without an access key, and with an HTTPS port,** match the web exactly. Pinned by `linksFor` tests.
3. **The guide grid stays usable with thousands of channels and a 24 h window,** with lazy rows. Checked on a device.
4. **The download progress stream stops when the screen leaves, and falls back to polling when the stream drops.** Checked on a device.
5. **Deleting the device's own viewer in Settings goes to the picker,** and doesn't keep sending the deleted viewer's ID. Checked on a device.

---

### Task 1: The pure rules and their tests

**Files:**
- Create: `data/repo/Part4Rules.kt`
- Modify: `data/api/Models.kt`, adding `EpgEvent`
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/Part4RulesTest.kt`

- [ ] **Step 1:** Append `EpgEvent` to `Models.kt`:
```kotlin
/** A programme in the guide (backend GuideManager.getChannelEvents); times in seconds. */
@JsonClass(generateAdapter = false)
data class EpgEvent(
    val id: Long = 0,
    val title: String = "",
    val startTime: Long = 0,
    val endTime: Long = 0,
    val description: String = "",
)
```

- [ ] **Step 2: Write the failing test**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Part4RulesTest {
    private val e = EpgEvent(id = 1, title = "News", startTime = 10_800, endTime = 14_400)   // 03:00–04:00

    @Test fun guideMaths() {
        assertEquals(1_800L, slotStart(3_599))
        assertEquals(Span(60f, 60f), eventSpan(e, 7_200, 90_000))        // starts an hour in
        assertEquals(Span(0f, 30f), eventSpan(e, 12_600, 90_000))         // clipped at the window start
        assertNull(eventSpan(e, 14_400, 90_000))                          // over before the window
        assertEquals(e, eventAt(listOf(e), 12_000))
        assertNull(eventAt(listOf(e), 14_400))
        assertEquals(0.5f, progressOf(e, 12_600), 0.001f)
        assertEquals(1f, progressOf(e, 99_999), 0.001f)
    }

    @Test fun serverEvents() {
        assertEquals("""[{"id":"a"}]""", parseSseData("""data: [{"id":"a"}]"""))
        assertNull(parseSseData(": keepalive"))
        assertNull(parseSseData(""))
    }

    @Test fun bytes() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("512 B", formatBytes(512))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("12.3 MB", formatBytes(12_897_485))
        assertEquals("2.0 GB", formatBytes(2L * 1024 * 1024 * 1024))
    }

    @Test fun linksAsTheWebBuildsThem() {
        val plain = linksFor("http://192.168.1.5:8983", null, "view_a", null).associate { it.label to it.url }
        assertEquals("http://192.168.1.5:8983", plain["Xtream Codes Server"])
        assertEquals("http://192.168.1.5:8983/v/view_a/stremio/manifest.json", plain["Stremio Addon"])
        assertEquals("http://192.168.1.5:8983/api/m3u?viewer=view_a", plain["M3U Playlist"])
        assertEquals("http://192.168.1.5:8983/api/xspf?viewer=view_a", plain["VLC Playlist"])
        assertEquals("http://192.168.1.5:8983/api/xmltv?viewer=view_a", plain["XMLTV EPG Guide"])
        assertNull(plain["Xtream Password"])

        val keyed = linksFor("http://192.168.1.5:8983", "tok", "view_a", 8984).associate { it.label to it.url }
        assertEquals("tok", keyed["Xtream Password"])
        assertEquals("http://192.168.1.5:8983/k/tok/api/m3u?viewer=view_a", keyed["M3U Playlist"])
        assertEquals("https://192.168.1.5:8984/k/tok/v/view_a/stremio/manifest.json", keyed["Stremio Addon"])
    }

    @Test fun filterLists() {
        val all = listOf("NEWS", "SPORTS", "KIDS")
        assertEquals(setOf("NEWS", "KIDS"), shownFrom(all, listOf("SPORTS")))
        assertEquals(listOf("SPORTS"), hiddenFrom(all, setOf("NEWS", "KIDS")))
    }

    @Test fun reminders() {
        val r = ReminderRules.reminderFor("42", "BBC One", e)
        assertEquals("42:10800", r.id)
        assertEquals((10_800L - 60) * 1000, ReminderRules.dueAtMs(r))
        assertTrue(ReminderRules.isUpcoming(r, nowMs = 10_000_000))
        assertTrue(!ReminderRules.isUpcoming(r, nowMs = 10_800_000))      // started: dropped
        assertEquals(listOf(r), ReminderRules.upcoming(listOf(r, r.copy(id = "old", startTime = 1)), nowMs = 1_000_000))
    }
}
```

- [ ] **Step 3: Push and confirm RED** (compile errors).

- [ ] **Step 4: Write `Part4Rules.kt`**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent
import java.net.URI
import java.net.URLEncoder
import java.util.Locale

// ── Guide ─────────────────────────────────────────────────────────────────────

/** Where a programme sits on the guide's timeline: minutes from the window start, and its length. */
data class Span(val offsetMinutes: Float, val durationMinutes: Float)

/** The start of the [slotMinutes] slot holding [nowSecs]. */
fun slotStart(nowSecs: Long, slotMinutes: Int = 30): Long = nowSecs - nowSecs % (slotMinutes * 60L)

/** [event] clipped to the window, or null when it's outside it. */
fun eventSpan(event: EpgEvent, windowStart: Long, windowEnd: Long): Span? {
    val s = maxOf(event.startTime, windowStart)
    val e = minOf(event.endTime, windowEnd)
    if (e <= s) return null
    return Span((s - windowStart) / 60f, (e - s) / 60f)
}

/** The programme airing at [timeSecs]. */
fun eventAt(events: List<EpgEvent>, timeSecs: Long): EpgEvent? = events.firstOrNull { it.startTime <= timeSecs && it.endTime > timeSecs }

/** How far through [event] [nowSecs] is, 0–1. */
fun progressOf(event: EpgEvent, nowSecs: Long): Float {
    val span = (event.endTime - event.startTime).coerceAtLeast(1)
    return ((nowSecs - event.startTime).toFloat() / span).coerceIn(0f, 1f)
}

// ── Downloads ─────────────────────────────────────────────────────────────────

/** The payload of a server-sent event line ("data: …"), or null for comments and blanks. */
fun parseSseData(line: String): String? = if (line.startsWith("data:")) line.removePrefix("data:").trimStart() else null

/** "512 B", "1.5 KB", "12.3 MB", "2.0 GB". */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = bytes / 1024.0
    var i = 0
    while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
    return String.format(Locale.ROOT, "%.1f %s", v, units[i])
}

// ── Links (Settings → Links), as the web's Setup page builds them ────────────

data class AppLink(val label: String, val url: String, val hint: String = "")

/**
 * This viewer's links for IPTV apps. With an access key, they carry the
 * playback-only token (/k/<token>); Stremio wants https, so with an HTTPS port
 * its link uses it.
 */
fun linksFor(base: String, shareToken: String?, viewerId: String?, httpsPort: Int?): List<AppLink> {
    val origin = base.trimEnd('/')
    val k = shareToken?.takeIf { it.isNotBlank() }?.let { "/k/$it" } ?: ""
    val id = viewerId?.takeIf { it.isNotBlank() }?.let { URLEncoder.encode(it, "UTF-8") }
    val vq = id?.let { "?viewer=$it" } ?: ""
    val vp = id?.let { "/v/$it" } ?: ""
    val stremioOrigin = runCatching {
        val u = URI(origin)
        if (u.scheme == "http" && httpsPort != null) "https://${u.host}:$httpsPort" else origin
    }.getOrDefault(origin)
    return buildList {
        add(AppLink("Xtream Codes Server", origin, "Server address for Xtream-compatible apps"))
        if (k.isNotEmpty()) add(AppLink("Xtream Password", shareToken!!, "Any username; this as the password"))
        add(AppLink("Stremio Addon", "$stremioOrigin$k$vp/stremio/manifest.json"))
        add(AppLink("M3U Playlist", "$origin$k/api/m3u$vq"))
        add(AppLink("VLC Playlist", "$origin$k/api/xspf$vq"))
        add(AppLink("XMLTV EPG Guide", "$origin$k/api/xmltv$vq"))
    }
}

// ── Viewer filters (Settings → Viewers): checked = shown, saved = the unchecked ──

fun shownFrom(all: List<String>, hidden: List<String>): Set<String> { val h = hidden.toSet(); return all.filter { it !in h }.toSet() }
fun hiddenFrom(all: List<String>, shown: Set<String>): List<String> = all.filter { it !in shown }

// ── Reminders ─────────────────────────────────────────────────────────────────

data class Reminder(val id: String, val channelId: String, val channelName: String, val title: String, val startTime: Long)

object ReminderRules {
    fun reminderFor(channelId: String, channelName: String, e: EpgEvent) =
        Reminder("$channelId:${e.startTime}", channelId, channelName, e.title, e.startTime)
    /** A minute before the start. */
    fun dueAtMs(r: Reminder): Long = (r.startTime - 60) * 1000
    /** Not started yet — a reminder for something already on is pointless. */
    fun isUpcoming(r: Reminder, nowMs: Long): Boolean = r.startTime * 1000 > nowMs
    fun upcoming(list: List<Reminder>, nowMs: Long): List<Reminder> = list.filter { isUpcoming(it, nowMs) }
}
```

- [ ] **Step 5: Push and confirm GREEN.** Expected: 67 tests, all PASSED.

### Task 2: The data layer

**Files:**
- Create: `data/api/Part4Models.kt`, `data/repo/GuideRepository.kt`, `data/repo/DownloadsRepository.kt`, `data/repo/SettingsRepository.kt`, `data/repo/RemindersRepository.kt`, `reminders/ReminderReceiver.kt`
- Modify:
  - `data/api/Models.kt` (`SettingsResponse` fields)
  - `data/api/StalkerApi.kt`
  - `data/repo/ViewerRepository.kt` (`filtersSaved`)
  - `data/repo/AppContainer.kt`
  - `data/prefs/AppPrefs.kt` (reminders, `settingsTab`)
  - `src/main/AndroidManifest.xml` (the receiver)

Code: Appendix A (models and API), Appendix B (repositories), Appendix C (receiver).

- [ ] **Step 1:** Write the files and edits from the appendices.
- [ ] **Step 2:** Push and confirm GREEN (67 tests, both flavors compile).

### Task 3: Guide UI

**Files:**
- Create: `ui/guide/GuideViewModel.kt`, `ui/guide/GuideScreen.kt` (Appendix D)
- Modify: `ui/shell/AppShell.kt` (Guide section and the reminders bell) and `MainActivity.kt` (factory, and opening a channel from a notification), as in Appendix G.

### Task 4: Downloads UI and VOD download buttons

**Files:**
- Create: `ui/downloads/DownloadsViewModel.kt`, `ui/downloads/DownloadsScreen.kt` (Appendix E)
- Modify: `ui/vod/VodViewModel.kt`, `ui/vod/VodScreen.kt`, `ui/vod/VodPlayerViewModel.kt` and `ui/vod/VodPlayerScreen.kt`, for the download buttons and toasts (Appendix E, part 2).

### Task 5: Settings tabs

**Files:**
- Create: `ui/settings/SettingsViewModel.kt` and `ui/settings/SettingsScreen.kt`, the latter replacing the part 1 placeholder (Appendix F).
- Modify: `MainActivity.kt` (factory) and `AppShell.kt` (Settings composable), as in Appendix G.

- [ ] Push Tasks 3–5 together after committing each, and confirm GREEN.

---

(The appendices follow, in the code the tasks copy.)


## Appendix A: models and API

`data/api/Part4Models.kt`:
```kotlin
package com.stalkerweb.android.data.api

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

// ── Guide ─────────────────────────────────────────────────────────────────────
@JsonClass(generateAdapter = false)
data class EpgResponse(
    val period: Int = 24,
    val channelCount: Int = 0,
    val epg: Map<String, List<EpgEvent>> = emptyMap(),
)

// ── Downloads (backend downloads/DownloadManager.js) ──────────────────────────
@JsonClass(generateAdapter = false)
data class DownloadJob(
    val id: String,
    val title: String = "",
    val seriesTitle: String = "",
    val status: String = "queued",          // queued | downloading | done | error | canceled
    val bytesDownloaded: Long = 0,
    val totalBytes: Long = 0,
    val error: String? = null,
    val createdAt: Long = 0,
)

@JsonClass(generateAdapter = false)
data class DownloadsResponse(val downloads: List<DownloadJob> = emptyList())

/** One title to download on the server (a movie, or an episode with its season). */
@JsonClass(generateAdapter = false)
data class DownloadItem(
    val videoId: String,
    val cmd: String = "",
    val series: String = "0",
    val seasonId: String = "",
    val episodeId: String = "",
    val title: String,
    val seriesTitle: String = "",
)

@JsonClass(generateAdapter = false)
data class DownloadRequest(val items: List<DownloadItem>)

// ── Settings ──────────────────────────────────────────────────────────────────
/** Changes to the shared settings (POST /api/settings); null fields are left as they are. */
@JsonClass(generateAdapter = false)
data class SettingsUpdate(
    @param:Json(name = "epg_enabled") val epgEnabled: Boolean? = null,
    @param:Json(name = "vod_enabled") val vodEnabled: Boolean? = null,
    @param:Json(name = "download_dir") val downloadDir: String? = null,
    @param:Json(name = "idle_timeout_minutes") val idleTimeoutMinutes: Int? = null,
    @param:Json(name = "live_buffer_seconds") val liveBufferSeconds: Int? = null,
)

@JsonClass(generateAdapter = false)
data class ViewerUpdate(val name: String? = null, val color: String? = null)

@JsonClass(generateAdapter = false)
data class ViewerFiltersRequest(
    val disabledGenres: List<String>,
    val disabledVodCategories: List<String>,
    val showAdult: Boolean,
)

@JsonClass(generateAdapter = false)
data class LogoStats(
    @param:Json(name = "db_size") val dbSize: Int = 0,
    @param:Json(name = "overrides_count") val overridesCount: Int = 0,
    @param:Json(name = "total_channels") val totalChannels: Int = 0,
    @param:Json(name = "matched_channels") val matchedChannels: Int = 0,
)

@JsonClass(generateAdapter = false)
data class LogosInfo(val overrides: Map<String, String> = emptyMap(), val stats: LogoStats = LogoStats())

@JsonClass(generateAdapter = false)
data class StripWordsResponse(val stripWords: List<String> = emptyList())

@JsonClass(generateAdapter = false)
data class WordRequest(val word: String)
```

`SettingsResponse` (Models.kt) gains, after `accessShareToken`:
```kotlin
    @param:Json(name = "download_dir") val downloadDir: String = "",
    @param:Json(name = "idle_timeout_minutes") val idleTimeoutMinutes: Int? = null,
    @param:Json(name = "https_port") val httpsPort: Int? = null,
    @param:Json(name = "live_buffer_seconds") val liveBufferSeconds: Int = 0,
    @param:Json(name = "access_enabled") val accessEnabled: Boolean = false,
    @param:Json(name = "stbemu_stb_model") val stbModel: String = "",
    @param:Json(name = "stbemu_firmware") val firmware: String = "",
```

`StalkerApi` — before `companion object`:
```kotlin
    // ── Part 4: guide, downloads, settings ────────────────────────────────────
    @GET("api/epg")
    suspend fun getEpg(@Query("period") period: Int = 24): EpgResponse

    @GET("api/downloads")
    suspend fun getDownloads(): DownloadsResponse

    @POST("api/downloads")
    suspend fun enqueueDownloads(@Body body: DownloadRequest)

    @DELETE("api/downloads/{id}")
    suspend fun removeDownload(@Path("id") id: String)

    @POST("api/settings")
    suspend fun saveSettings(@Body body: SettingsUpdate)

    @PUT("api/viewers/{id}")
    suspend fun updateViewer(@Path("id") id: String, @Body body: ViewerUpdate): ViewerSummary

    @DELETE("api/viewers/{id}")
    suspend fun deleteViewer(@Path("id") id: String)

    @PUT("api/viewers/me/filters")
    suspend fun saveMyFilters(@Body body: ViewerFiltersRequest): ViewerDetails

    @GET("api/vod/categories")
    suspend fun getPortalVodCategories(@Query("type") type: String, @Query("all") all: String = "1"): VodCategoriesResponse

    @POST("api/profiles")
    suspend fun createProfile(@Body body: Profile)

    @PUT("api/profiles/{id}")
    suspend fun updateProfile(@Path("id") id: String, @Body body: Profile)

    @DELETE("api/profiles/{id}")
    suspend fun deleteProfile(@Path("id") id: String)

    @GET("api/logos")
    suspend fun getLogos(): LogosInfo

    @POST("api/logos/refresh")
    suspend fun refreshLogos()

    @DELETE("api/logos/{name}")
    suspend fun deleteLogoOverride(@Path("name") name: String)

    @GET("api/logos/strip")
    suspend fun getStripWords(): StripWordsResponse

    @POST("api/logos/strip")
    suspend fun addStripWord(@Body body: WordRequest)

    @DELETE("api/logos/strip/{word}")
    suspend fun deleteStripWord(@Path("word") word: String)
```

## Appendix B: repositories

`data/repo/GuideRepository.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent

/** The programme guide (backend /api/epg, 24 h), by channel uniqueId, each in time order; cached 10 minutes. */
class GuideRepository(private val apis: ApiProvider) {
    private var cache: Pair<Long, Map<String, List<EpgEvent>>>? = null

    suspend fun guide(force: Boolean = false): Map<String, List<EpgEvent>> {
        val now = System.currentTimeMillis()
        cache?.let { (at, epg) -> if (!force && now - at < 10 * 60_000L) return epg }
        val epg = apis.get().getEpg(24).epg.mapValues { (_, events) -> events.sortedBy { it.startTime } }
        cache = now to epg
        return epg
    }
}
```

`data/repo/DownloadsRepository.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import com.stalkerweb.android.data.api.DownloadItem
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.api.DownloadRequest
import com.stalkerweb.android.data.prefs.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request

/** Downloads to the server's disk (backend routes/downloads.js). */
class DownloadsRepository(private val apis: ApiProvider, private val prefs: AppPrefs, private val client: OkHttpClient) {
    private val adapter = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        .adapter<List<DownloadJob>>(Types.newParameterizedType(List::class.java, DownloadJob::class.java))

    suspend fun list(): List<DownloadJob> = apis.get().getDownloads().downloads
    suspend fun enqueue(items: List<DownloadItem>) = apis.get().enqueueDownloads(DownloadRequest(items))
    suspend fun remove(id: String) = apis.get().removeDownload(id)

    /**
     * The downloads as they change — the server's event stream, read line by
     * line on the app's client (it carries the key and goes through the access
     * guard). Completes when the stream ends or fails; the caller falls back
     * to polling.
     */
    fun events(): Flow<List<DownloadJob>> = callbackFlow {
        val base = prefs.serverUrl?.trimEnd('/')
        if (base == null) { close(); return@callbackFlow }
        val call = client.newCall(Request.Builder().url("$base/api/downloads/events").build())
        val reader = launch(Dispatchers.IO) {
            runCatching {
                call.execute().use { resp ->
                    if (resp.isSuccessful) {
                        val source = resp.body.source()
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            parseSseData(line)?.let { json -> runCatching { adapter.fromJson(json) }.getOrNull()?.let { trySend(it) } }
                        }
                    }
                }
            }
            close()
        }
        awaitClose { call.cancel(); reader.cancel() }
    }
}
```

`data/repo/SettingsRepository.kt`:
```kotlin
package com.stalkerweb.android.data.repo

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
    suspend fun settings(): SettingsResponse = apis.get().getSettings().also {
        if (!prefs.accessKey.isNullOrBlank()) prefs.shareToken = it.accessShareToken
    }
    suspend fun save(update: SettingsUpdate) = apis.get().saveSettings(update)

    // Viewers
    suspend fun renameViewer(id: String, name: String) = apis.get().updateViewer(id, ViewerUpdate(name = name.trim()))
    suspend fun recolorViewer(id: String, color: String) = apis.get().updateViewer(id, ViewerUpdate(color = color))
    suspend fun deleteViewer(id: String) = apis.get().deleteViewer(id)
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
```

`data/repo/RemindersRepository.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.reminders.ReminderReceiver
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** "Remind me" for guide programmes — kept on this device (as on the web), a notification a minute before. */
class RemindersRepository(private val context: Context, private val prefs: AppPrefs) {
    private val _list = MutableStateFlow(ReminderRules.upcoming(prefs.reminders, System.currentTimeMillis()))
    val list: StateFlow<List<Reminder>> = _list.asStateFlow()

    fun isSet(channelId: String, event: EpgEvent): Boolean = _list.value.any { it.id == "$channelId:${event.startTime}" }

    /** Sets or clears the reminder; returns true when set. A programme already on can't be set. */
    fun toggle(channelId: String, channelName: String, event: EpgEvent): Boolean {
        val r = ReminderRules.reminderFor(channelId, channelName, event)
        if (_list.value.any { it.id == r.id }) { remove(r.id); return false }
        if (!ReminderRules.isUpcoming(r, System.currentTimeMillis())) return false
        save(_list.value + r)
        schedule(r)
        return true
    }

    fun remove(id: String) {
        _list.value.firstOrNull { it.id == id }?.let(::cancel)
        save(_list.value.filter { it.id != id })
    }

    /** The alarm went off: it's no longer pending. */
    fun fired(id: String) = save(_list.value.filter { it.id != id })

    private fun save(list: List<Reminder>) {
        prefs.reminders = list
        _list.value = list
    }

    private fun intent(r: Reminder) = PendingIntent.getBroadcast(
        context, r.id.hashCode(),
        Intent(context, ReminderReceiver::class.java)
            .putExtra(ReminderReceiver.EXTRA_ID, r.id)
            .putExtra(ReminderReceiver.EXTRA_CHANNEL_ID, r.channelId)
            .putExtra(ReminderReceiver.EXTRA_CHANNEL_NAME, r.channelName)
            .putExtra(ReminderReceiver.EXTRA_TITLE, r.title),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun schedule(r: Reminder) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        // Inexact (no exact-alarm permission needed): at most a few minutes late.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, ReminderRules.dueAtMs(r), intent(r))
    }

    private fun cancel(r: Reminder) {
        context.getSystemService(AlarmManager::class.java)?.cancel(intent(r))
    }
}
```

`AppPrefs` — after `favoritesOpen`:
```kotlin
    // Guide reminders on this device (the web keeps its own).
    var reminders: List<com.stalkerweb.android.data.repo.Reminder>
        get() = runCatching {
            val arr = JSONArray(prefs.getString(KEY_REMINDERS, null) ?: "[]")
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                com.stalkerweb.android.data.repo.Reminder(o.getString("id"), o.getString("channelId"), o.getString("channelName"), o.getString("title"), o.getLong("startTime"))
            }
        }.getOrDefault(emptyList())
        set(value) {
            val arr = JSONArray()
            value.forEach { r -> arr.put(JSONObject().put("id", r.id).put("channelId", r.channelId).put("channelName", r.channelName).put("title", r.title).put("startTime", r.startTime)) }
            prefs.edit().putString(KEY_REMINDERS, arr.toString()).apply()
        }

    // The Settings tab last open.
    var settingsTab: String
        get() = prefs.getString(KEY_SETTINGS_TAB, null) ?: "viewers"
        set(value) = prefs.edit().putString(KEY_SETTINGS_TAB, value).apply()
```
keys: `KEY_REMINDERS = "guide_reminders"`, `KEY_SETTINGS_TAB = "settings_tab"`.

`ViewerRepository`:
```kotlin
    /** The viewer's filters changed (Settings): read them, and have every section reload. */
    suspend fun filtersSaved() {
        refresh()
        _changes.value += 1
    }
```

`AppContainer` — after `watch`:
```kotlin
    val guide = GuideRepository(apis)
    val downloads = DownloadsRepository(apis, prefs, httpClient)
    val settings = SettingsRepository(apis, prefs)
    val reminders = RemindersRepository(context.applicationContext, prefs)
```

## Appendix C: `reminders/ReminderReceiver.kt` + manifest

```kotlin
package com.stalkerweb.android.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.stalkerweb.android.MainActivity
import com.stalkerweb.android.R
import com.stalkerweb.android.StalkerWebApp

/** A guide reminder came due: "Starting now: <title> on <channel>"; tapping it opens that channel. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val channelId = intent.getStringExtra(EXTRA_CHANNEL_ID) ?: return
        val channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        (context.applicationContext as? StalkerWebApp)?.container?.reminders?.fired(id)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Guide reminders", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val open = PendingIntent.getActivity(
            context, id.hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_CHANNEL_ID, channelId)
                .putExtra(EXTRA_CHANNEL_NAME, channelName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Starting now: $title")
            .setContentText(channelName)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val allowed = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (allowed) runCatching { NotificationManagerCompat.from(context).notify(id.hashCode(), notification) }
    }

    companion object {
        const val CHANNEL = "stalkerweb_reminders"
        const val EXTRA_ID = "reminderId"
        const val EXTRA_CHANNEL_ID = "channelId"
        const val EXTRA_CHANNEL_NAME = "channelName"
        const val EXTRA_TITLE = "title"
    }
}
```

Manifest (`src/main/AndroidManifest.xml`), inside `<application>` after the service:
```xml
        <receiver android:name=".reminders.ReminderReceiver" android:exported="false" />
```


## Appendix D: Guide

`ui/guide/GuideViewModel.kt`:
```kotlin
package com.stalkerweb.android.ui.guide

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.GuideRepository
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.data.repo.RemindersRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

const val FAVORITES_FILTER = "__favorites"

data class GuideState(
    val channels: List<Channel> = emptyList(),          // the viewer's, with guide data
    val epg: Map<String, List<EpgEvent>> = emptyMap(),
    val groups: List<Group> = emptyList(),
    val favoriteIds: Set<String> = emptySet(),
    val logoMap: Map<String, String> = emptyMap(),
    val filter: String? = null,                         // null = All; a genre id; or FAVORITES_FILTER
    val loading: Boolean = true,
    val error: String? = null,
) {
    val shown: List<Channel> get() = when (filter) {
        null -> channels
        FAVORITES_FILTER -> channels.filter { it.uniqueId in favoriteIds }
        else -> channels.filter { it.genreId == filter }
    }
}

/** The guide (the web's EpgGridPage / GuideListView): the viewer's channels that have programmes. */
class GuideViewModel(
    private val guide: GuideRepository,
    private val live: LiveRepository,
    val reminders: RemindersRepository,
    viewers: ViewerRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(GuideState())
    val state: StateFlow<GuideState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch { viewers.changes.drop(1).collect { load() } }
    }

    fun load(force: Boolean = false) {
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching {
                val epg = guide.guide(force)
                val channels = live.getChannels().filter { !epg[it.uniqueId].isNullOrEmpty() }
                _state.value = _state.value.copy(
                    channels = channels, epg = epg, groups = live.getGroups(), favoriteIds = live.getFavoriteIds(),
                    logoMap = live.getLogoMap(), loading = false,
                )
            }.onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message) }
        }
    }

    fun setFilter(f: String?) { _state.value = _state.value.copy(filter = f) }
}
```

`ui/guide/GuideScreen.kt`:
```kotlin
package com.stalkerweb.android.ui.guide

import android.Manifest
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.repo.eventAt
import com.stalkerweb.android.data.repo.eventSpan
import com.stalkerweb.android.data.repo.progressOf
import com.stalkerweb.android.data.repo.slotStart
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val MINUTE: Dp = 6.dp
private val ROW: Dp = 64.dp
private val CHANNEL_COL: Dp = 180.dp
private const val BEFORE_SECS = 30 * 60L
private const val WINDOW_SECS = 24 * 3600L + BEFORE_SECS

private val hm = SimpleDateFormat("HH:mm", Locale.getDefault())
private fun clock(secs: Long): String = hm.format(Date(secs * 1000))

/**
 * The guide: a timeline grid on TV and wide screens (channels down the side,
 * programmes across; the remote moves Up/Down between channels and
 * Left/Right between programmes), a channel → schedule list on phones.
 * OK on a programme: details, with Watch (on now) or Remind me (later).
 */
@Composable
fun GuideScreen(viewModel: GuideViewModel, onWatch: (Channel) -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val reminders by viewModel.reminders.list.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val wide = isTV || LocalConfiguration.current.screenWidthDp >= 600
    val context = LocalContext.current
    var details by remember { mutableStateOf<Pair<Channel, EpgEvent>?>(null) }
    var phoneChannel by remember { mutableStateOf<Channel?>(null) }
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val nowSecs = remember(state.epg) { System.currentTimeMillis() / 1000 }

    fun toggleReminder(ch: Channel, e: EpgEvent) {
        if (Build.VERSION.SDK_INT >= 33) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        val set = viewModel.reminders.toggle(ch.uniqueId, ch.name, e)
        Toast.makeText(context, if (set) "We'll remind you when ${e.title} starts" else "Reminder removed", Toast.LENGTH_SHORT).show()
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!wide && phoneChannel != null) IconButton(onClick = { phoneChannel = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Channels") }
            Text(phoneChannel?.name ?: "Guide", style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.weight(1f))
            IconButton(onClick = { viewModel.load(force = true) }) { Icon(Icons.Default.Refresh, "Refresh guide") }
        }
        if (phoneChannel == null) {
            LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Pill("All", state.filter == null, { viewModel.setFilter(null) }) }
                item { Pill("Favorites", state.filter == FAVORITES_FILTER, { viewModel.setFilter(FAVORITES_FILTER) }, leading = Icons.Default.Favorite) }
                items(state.groups, key = { it.id }) { g -> Pill(g.name, state.filter == g.id, { viewModel.setFilter(g.id) }) }
            }
        }
        when {
            state.loading && state.channels.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            state.error != null && state.channels.isEmpty() -> EmptyState(Icons.Default.GridView, "Couldn't load the guide", state.error) {
                Button(onClick = { viewModel.load(force = true) }) { Text("Retry") }
            }
            state.shown.isEmpty() -> EmptyState(Icons.Default.GridView, "No guide data", "The portal has no programmes for these channels.")
            wide -> GuideGrid(state, nowSecs, reminders.map { it.id }.toSet()) { ch, e -> details = ch to e }
            phoneChannel == null -> LazyColumn {
                items(state.shown, key = { it.uniqueId }) { ch ->
                    val now = eventAt(state.epg[ch.uniqueId].orEmpty(), nowSecs)
                    Row(Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { phoneChannel = ch }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Logo(state.logoMap[ch.uniqueId], 40.dp)
                        Column(Modifier.weight(1f)) {
                            Text(ch.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(now?.title ?: "—", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            else -> {
                val ch = phoneChannel!!
                val events = state.epg[ch.uniqueId].orEmpty().filter { it.endTime > nowSecs }
                LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(events, key = { it.startTime }) { e ->
                        val on = e.startTime <= nowSecs
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(if (on) SwColors.Surface2 else SwColors.Surface)
                                .tvFocus(RoundedCornerShape(8.dp)).clickable { details = ch to e }.padding(12.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("${clock(e.startTime)}–${clock(e.endTime)}", color = SwColors.Muted, style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(96.dp))
                                Text(e.title, color = SwColors.Text, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                if (reminders.any { it.id == "${ch.uniqueId}:${e.startTime}" }) Icon(Icons.Default.NotificationsActive, "Reminder set", Modifier.size(16.dp), tint = SwColors.Warning)
                            }
                            if (on) LinearProgressIndicator(progress = { progressOf(e, nowSecs) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp).height(3.dp), color = SwColors.Primary, trackColor = SwColors.Surface3)
                        }
                    }
                }
            }
        }
    }

    details?.let { (ch, e) ->
        val on = e.startTime <= nowSecs && e.endTime > nowSecs
        val set = reminders.any { it.id == "${ch.uniqueId}:${e.startTime}" }
        AlertDialog(
            onDismissRequest = { details = null },
            title = { Text(e.title) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${ch.name} · ${clock(e.startTime)}–${clock(e.endTime)}", color = SwColors.Muted)
                    if (e.description.isNotBlank()) Text(e.description, color = SwColors.Text, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                when {
                    on -> Button(onClick = { details = null; onWatch(ch) }) { Text("Watch") }
                    e.startTime > nowSecs -> Button(onClick = { toggleReminder(ch, e); details = null }) {
                        Icon(if (set) Icons.Default.NotificationsActive else Icons.Default.Notifications, null, Modifier.size(16.dp))
                        Text(if (set) "  Remove reminder" else "  Remind me")
                    }
                    else -> {}
                }
            },
            dismissButton = { TextButton(onClick = { details = null }) { Text("Close") } },
        )
    }
}

@Composable
private fun Logo(url: String?, size: Dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(6.dp)).background(SwColors.Surface2), Alignment.Center) {
        if (url != null) AsyncImage(url, null, Modifier.size(size - 4.dp), contentScale = ContentScale.Fit)
        else Icon(Icons.Default.Tv, null, Modifier.size(size / 2), tint = SwColors.Muted)
    }
}

/** Channels down the side, a 24-hour timeline across — every row sharing one horizontal scroll. */
@Composable
private fun GuideGrid(state: GuideState, nowSecs: Long, reminderIds: Set<String>, onOpen: (Channel, EpgEvent) -> Unit) {
    val windowStart = slotStart(nowSecs) - BEFORE_SECS
    val windowEnd = windowStart + WINDOW_SECS
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val timelineWidth = MINUTE * (WINDOW_SECS / 60f)
    // Open at about now (a slot before it).
    LaunchedEffect(Unit) { scroll.scrollTo(with(density) { (MINUTE * ((nowSecs - windowStart - 15 * 60) / 60f)).roundToPx() }) }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().height(28.dp)) {
            Box(Modifier.width(CHANNEL_COL))
            Box(Modifier.weight(1f).horizontalScroll(scroll)) {
                Box(Modifier.width(timelineWidth).fillMaxHeight()) {
                    var t = windowStart
                    while (t < windowEnd) {
                        Text(clock(t), style = MaterialTheme.typography.labelSmall, color = SwColors.Muted,
                            modifier = Modifier.offset(x = MINUTE * ((t - windowStart) / 60f)).padding(start = 4.dp))
                        t += 30 * 60
                    }
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(state.shown, key = { it.uniqueId }) { ch ->
                GuideRow(ch, state.logoMap[ch.uniqueId], state.epg[ch.uniqueId].orEmpty(), windowStart, windowEnd, nowSecs, scroll, timelineWidth, reminderIds, onOpen)
            }
        }
    }
}

@Composable
private fun GuideRow(
    ch: Channel, logo: String?, events: List<EpgEvent>, windowStart: Long, windowEnd: Long, nowSecs: Long,
    scroll: ScrollState, timelineWidth: Dp, reminderIds: Set<String>, onOpen: (Channel, EpgEvent) -> Unit,
) {
    Row(Modifier.fillMaxWidth().height(ROW).padding(vertical = 2.dp)) {
        Row(Modifier.width(CHANNEL_COL).fillMaxHeight().background(SwColors.Surface).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Logo(logo, 40.dp)
            Text(ch.name, color = SwColors.Text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.weight(1f).fillMaxHeight().horizontalScroll(scroll)) {
            Box(Modifier.width(timelineWidth).fillMaxHeight()) {
                events.forEach { e ->
                    val span = eventSpan(e, windowStart, windowEnd) ?: return@forEach
                    val on = e.startTime <= nowSecs && e.endTime > nowSecs
                    Box(
                        Modifier.offset(x = MINUTE * span.offsetMinutes).width((MINUTE * span.durationMinutes - 2.dp).coerceAtLeast(4.dp)).fillMaxHeight()
                            .tvFocus(RoundedCornerShape(6.dp))
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (on) SwColors.Surface3 else SwColors.Surface2)
                            .clickable { onOpen(ch, e) }
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                    ) {
                        Column {
                            Text(e.title, color = SwColors.Text, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(clock(e.startTime), color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
                                if ("${ch.uniqueId}:${e.startTime}" in reminderIds) Icon(Icons.Default.NotificationsActive, "Reminder set", Modifier.padding(start = 4.dp).size(12.dp), tint = SwColors.Warning)
                            }
                        }
                    }
                }
                // Now
                Box(Modifier.offset(x = MINUTE * ((nowSecs - windowStart) / 60f)).width(2.dp).fillMaxHeight().background(SwColors.Live))
            }
        }
    }
}
```


## Appendix E: Downloads

`ui/downloads/DownloadsViewModel.kt`:
```kotlin
package com.stalkerweb.android.ui.downloads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.DownloadsRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class DownloadsState(val jobs: List<DownloadJob> = emptyList(), val loading: Boolean = true, val error: String? = null)

/** The server's downloads, live while the screen is in front (the event stream; polling when it drops). */
class DownloadsViewModel(private val downloads: DownloadsRepository) : ViewModel() {
    private val _state = MutableStateFlow(DownloadsState())
    val state: StateFlow<DownloadsState> = _state.asStateFlow()
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Runs while the screen is started (cancelled when it isn't). */
    suspend fun follow() {
        while (true) {
            refresh()
            downloads.events().collect { _state.value = DownloadsState(jobs = it.sortedByDescending { j -> j.createdAt }, loading = false) }
            // The stream ended or failed: poll for a while, then try the stream again.
            repeat(10) { delay(3_000); refresh() }
        }
    }

    private suspend fun refresh() {
        runCatching { downloads.list() }
            .onSuccess { _state.value = DownloadsState(jobs = it.sortedByDescending { j -> j.createdAt }, loading = false) }
            .onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message) }
    }

    fun remove(job: DownloadJob) {
        viewModelScope.launch {
            runCatching { downloads.remove(job.id) }
                .onSuccess { refresh() }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Couldn't remove it") }
        }
    }
}
```

`ui/downloads/DownloadsScreen.kt`:
```kotlin
package com.stalkerweb.android.ui.downloads

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.repo.formatBytes
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors

/** Downloads to the server (the web's DownloadsPage): live progress, Cancel / Delete. */
@Composable
fun DownloadsScreen(viewModel: DownloadsViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { viewModel.follow() } }
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    Column(Modifier.fillMaxSize()) {
        Text("Downloads", style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.padding(16.dp))
        when {
            state.loading -> CircularProgressIndicator(Modifier.padding(32.dp))
            state.jobs.isEmpty() -> EmptyState(Icons.Default.Download, "No downloads", state.error ?: "Download a movie or episode from VOD to save it on the server.")
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.jobs, key = { it.id }) { job -> JobRow(job) { viewModel.remove(job) } }
            }
        }
    }
}

@Composable
private fun JobRow(job: DownloadJob, onRemove: () -> Unit) {
    val active = job.status == "queued" || job.status == "downloading"
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    if (job.seriesTitle.isNotBlank()) Text(job.seriesTitle, style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                    Text(job.title, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        when (job.status) {
                            "queued" -> "Queued"
                            "downloading" -> "Downloading · ${formatBytes(job.bytesDownloaded)}${if (job.totalBytes > 0) " of ${formatBytes(job.totalBytes)}" else ""}"
                            "done" -> "Done · ${formatBytes(job.totalBytes.coerceAtLeast(job.bytesDownloaded))}"
                            "canceled" -> "Canceled"
                            else -> "Failed${job.error?.let { " — $it" } ?: ""}"
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = if (job.status == "error") SwColors.Live else SwColors.Muted,
                    )
                }
                OutlinedButton(onClick = onRemove, modifier = Modifier.tvFocus(RoundedCornerShape(50))) { Text(if (active) "Cancel" else "Delete") }
            }
            if (job.status == "downloading") {
                if (job.totalBytes > 0) {
                    LinearProgressIndicator(progress = { (job.bytesDownloaded.toFloat() / job.totalBytes).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().height(4.dp), color = SwColors.Primary, trackColor = SwColors.Surface3)
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(4.dp), color = SwColors.Primary, trackColor = SwColors.Surface3)
                }
            }
        }
    }
}
```

### Part 2: download buttons in VOD

**`VodViewModel`:**
- Add the constructor parameter `private val downloads: DownloadsRepository`, after `prefs`.
- Add:
```kotlin
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Short messages for a toast ("Queued …"). */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Queues titles to download on the server (as the web's VOD page does). */
    fun download(items: List<DownloadItem>, what: String) {
        viewModelScope.launch {
            runCatching { downloads.enqueue(items) }
                .onSuccess { _messages.tryEmit("Queued $what for download") }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Could not queue download") }
        }
    }
```
- Imports: `DownloadItem`, `DownloadsRepository`, `MutableSharedFlow`, `SharedFlow`, `asSharedFlow`.

**`VodScreen`:**
- **Toasts:** in `VodScreen`, after the first `LaunchedEffect`, add:
  ```kotlin
      val ctx = androidx.compose.ui.platform.LocalContext.current
      LaunchedEffect(viewModel) { viewModel.messages.collect { android.widget.Toast.makeText(ctx, it, android.widget.Toast.LENGTH_SHORT).show() } }
  ```
- **Poster download button:** in `Content`'s grid `PosterTile`, add `onDownload = if (item.isSeries || item.episodes.isNotEmpty()) null else ({ viewModel.download(listOf(DownloadItem(videoId = item.id, cmd = item.cmd, title = item.name)), "\"${item.name}\"") })`.
- **`SeriesDialog`** takes `onDownloadEpisode: (VodSeason, VodEpisode) -> Unit` and `onDownloadSeason: (VodSeason, List<VodEpisode>) -> Unit`.
  - **Episode rows:** each gets a trailing `IconButton(Icons.Default.Download, "Download")` that calls `onDownloadEpisode(selectedSeason, ep)`.
  - **Header:** while a season is open, a `Pill("Download season", false, { onDownloadSeason(selectedSeason, episodes.orEmpty()) }, leading = Icons.Default.Download)`.
  - **The call site passes:**
    ```kotlin
                onDownloadEpisode = { season, ep -> viewModel.download(listOf(DownloadItem(videoId = show.id, cmd = show.cmd, series = ep.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = ep.episodeId, title = ep.name.ifBlank { "Episode ${ep.seriesNumber}" }, seriesTitle = show.name)), "\"${ep.name.ifBlank { "Episode ${ep.seriesNumber}" }}\"") },
                onDownloadSeason = { season, eps -> viewModel.download(eps.map { ep -> DownloadItem(videoId = show.id, cmd = show.cmd, series = ep.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = ep.episodeId, title = ep.name.ifBlank { "Episode ${ep.seriesNumber}" }, seriesTitle = show.name) }, "${eps.size} episodes") },
    ```

**`VodPlayerViewModel`:**
- Add the constructor parameter `private val downloads: DownloadsRepository`, last.
- Add:
```kotlin
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** This movie or episode, downloaded to the server. */
    fun download() {
        val p = _state.value.params ?: return
        val item = DownloadItem(
            videoId = p.videoId, cmd = if (p.isEpisode) "" else p.cmd, series = p.series, seasonId = p.seasonId, episodeId = p.episodeId,
            title = if (p.isEpisode) p.episodeTitle.ifBlank { p.title } else p.title, seriesTitle = if (p.isEpisode) p.title else "",
        )
        viewModelScope.launch {
            runCatching { downloads.enqueue(listOf(item)) }
                .onSuccess { _messages.tryEmit("Queued \"${item.title}\" for download") }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Could not queue download") }
        }
    }
```

**`VodPlayerScreen`:**
- In the top bar, before the My List `IconButton`, add `IconButton(onClick = viewModel::download) { Icon(Icons.Default.Download, "Download to server", tint = Color.White) }`.
- Collect `viewModel.messages` into a `Toast`, as in `VodScreen`.

**`MainActivity` factories:**
- `VodViewModel(container.vod, container.watch, container.viewers, container.prefs, container.downloads)`
- `VodPlayerViewModel(application, container.vod, container.watch, container.links, container.downloads)`


## Appendix F: Settings

`ui/settings/SettingsViewModel.kt`:
```kotlin
package com.stalkerweb.android.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.LogosInfo
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.ProfilesResponse
import com.stalkerweb.android.data.api.SettingsResponse
import com.stalkerweb.android.data.api.SettingsUpdate
import com.stalkerweb.android.data.api.StatusResponse
import com.stalkerweb.android.data.api.ViewerFiltersRequest
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.SettingsRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

val SETTINGS_TABS = listOf("viewers" to "Viewers", "connection" to "Connection", "links" to "Links", "playback" to "Playback", "logos" to "Logos")

data class SettingsState(
    val tab: String = "viewers",
    val settings: SettingsResponse? = null,
    val viewers: List<ViewerSummary> = emptyList(),
    val genres: List<String> = emptyList(),          // every channel genre
    val movieCategories: List<String> = emptyList(),
    val seriesCategories: List<String> = emptyList(),
    val profiles: ProfilesResponse = ProfilesResponse(),
    val status: StatusResponse? = null,
    val logos: LogosInfo? = null,
    val stripWords: List<String> = emptyList(),
    val busy: Boolean = false,
)

/** The Settings tabs, as on the web (pages/SetupPage.jsx). */
class SettingsViewModel(
    private val settings: SettingsRepository,
    private val server: ServerRepository,
    val viewers: ViewerRepository,
    private val prefs: AppPrefs,
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsState(tab = prefs.settingsTab))
    val state: StateFlow<SettingsState> = _state.asStateFlow()
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    init { load() }

    fun setTab(tab: String) { prefs.settingsTab = tab; _state.value = _state.value.copy(tab = tab); load() }

    /** What the open tab needs. */
    fun load() {
        viewModelScope.launch {
            val s = _state.value
            runCatching {
                when (s.tab) {
                    "viewers" -> _state.value = _state.value.copy(
                        viewers = viewers.list(),
                        genres = settings.allGenres().map { it.name },
                        movieCategories = settings.portalCategories("vod"),
                        seriesCategories = settings.portalCategories("series"),
                    ).also { if (viewers.current.value == null) viewers.refresh() }
                    "connection" -> _state.value = _state.value.copy(profiles = server.getProfiles(), status = server.testConnection(), settings = settings.settings())
                    "links", "playback" -> _state.value = _state.value.copy(settings = settings.settings())
                    "logos" -> _state.value = _state.value.copy(logos = settings.logos(), stripWords = settings.stripWords())
                }
            }.onFailure { say(it) }
        }
    }

    private fun say(e: Throwable) { _messages.tryEmit(e.toApiError().message ?: "Something went wrong") }

    private fun act(done: String? = null, call: suspend () -> Unit) {
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true)
            runCatching { call() }.onSuccess { done?.let(_messages::tryEmit); load() }.onFailure(::say)
            _state.value = _state.value.copy(busy = false)
        }
    }

    // Viewers
    fun rename(v: ViewerSummary, name: String) = act { settings.renameViewer(v.id, name); viewers.refresh() }
    fun recolor(v: ViewerSummary, color: String) = act { settings.recolorViewer(v.id, color); viewers.refresh() }
    fun addViewer(name: String) = act("Added $name") { viewers.create(name) }
    /** Deletes a viewer; [onOwnDeleted] when it was this device's (the picker asks again). */
    fun deleteViewer(v: ViewerSummary, onOwnDeleted: () -> Unit) = act("Deleted ${v.name}") {
        settings.deleteViewer(v.id)
        if (v.id == viewers.savedViewerId()) { viewers.forget(); onOwnDeleted() }
    }
    fun saveFilters(hiddenGenres: List<String>, hiddenCategories: List<String>, showAdult: Boolean) = act("Saved") {
        settings.saveFilters(ViewerFiltersRequest(hiddenGenres, hiddenCategories, showAdult))
        viewers.filtersSaved()
    }

    // Connection
    fun connect(p: Profile) = act { val r = server.connectProfile(p); if (!r.success) throw IllegalStateException(r.error ?: "Couldn't connect") }
    fun disconnect() = act("Disconnected") { server.disconnectPortal() }
    fun reconnect() = act { val r = server.reconnectPortal(); if (!r.success) throw IllegalStateException(r.error ?: "Couldn't reconnect") }
    fun saveProfile(p: Profile) = act("Saved") { if (p.id.isBlank()) settings.createProfile(p) else settings.updateProfile(p) }
    fun deleteProfile(p: Profile) = act("Deleted") { settings.deleteProfile(p.id) }

    // Playback
    fun savePlayback(update: SettingsUpdate) = act("Saved") { settings.save(update) }

    // Logos
    fun refreshLogos() = act("Logo database refreshed") { settings.refreshLogos() }
    fun addOverride(name: String, url: String) = act { settings.addOverride(name, url) }
    fun removeOverride(name: String) = act { settings.removeOverride(name) }
    fun addStripWord(w: String) = act { settings.addStripWord(w) }
    fun removeStripWord(w: String) = act { settings.removeStripWord(w) }
}
```

`ui/settings/SettingsScreen.kt` (replaces the part 1 placeholder):
```kotlin
package com.stalkerweb.android.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.SettingsUpdate
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.repo.hiddenFrom
import com.stalkerweb.android.data.repo.linksFor
import com.stalkerweb.android.data.repo.shownFrom
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.ViewerAvatar
import com.stalkerweb.android.ui.components.parseHexColor
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

private val VIEWER_COLORS = listOf("#5b8def", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#12a594", "#e93d82", "#978365")

/** Settings, with the web's tabs: Viewers, Connection, Links, Playback, Logos. */
@Composable
fun SettingsScreen(viewModel: SettingsViewModel, serverUrl: String?, onOpenServer: () -> Unit, onOwnViewerDeleted: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    Column(Modifier.fillMaxSize()) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall, color = SwColors.Text, modifier = Modifier.padding(start = 16.dp, top = 12.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(SETTINGS_TABS, key = { it.first }) { (id, label) -> Pill(label, state.tab == id, { viewModel.setTab(id) }) }
        }
        HorizontalDivider(color = SwColors.Border)
        Box(Modifier.fillMaxSize().padding(16.dp)) {
            when (state.tab) {
                "viewers" -> ViewersTab(viewModel, state, onOwnViewerDeleted)
                "connection" -> ConnectionTab(viewModel, state, serverUrl, onOpenServer)
                "links" -> LinksTab(state, serverUrl, viewModel.viewers.savedViewerId())
                "playback" -> PlaybackTab(viewModel, state)
                "logos" -> LogosTab(viewModel, state)
            }
        }
    }
}

@Composable
private fun Card(title: String, description: String? = null, content: @Composable () -> Unit) {
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().widthIn(max = 900.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = SwColors.Text)
            if (description != null) Text(description, style = MaterialTheme.typography.bodySmall, color = SwColors.Muted)
            content()
        }
    }
}

// ── Viewers ───────────────────────────────────────────────────────────────────

@Composable
private fun ViewersTab(viewModel: SettingsViewModel, state: SettingsState, onOwnViewerDeleted: () -> Unit) {
    val me by viewModel.viewers.current.collectAsStateWithLifecycle()
    var renaming by remember { mutableStateOf<ViewerSummary?>(null) }
    var deleting by remember { mutableStateOf<ViewerSummary?>(null) }
    var adding by remember { mutableStateOf(false) }
    // The filter checklists, edited here and saved together.
    var shownGenres by remember(me, state.genres) { mutableStateOf(shownFrom(state.genres, me?.disabledGenres.orEmpty())) }
    val allCats = (state.movieCategories + state.seriesCategories).distinct()
    var shownCats by remember(me, allCats) { mutableStateOf(shownFrom(allCats, me?.disabledVodCategories.orEmpty())) }
    var showAdult by remember(me) { mutableStateOf(me?.showAdult == true) }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Card("Viewers", "Everyone who watches here. Each viewer has their own favorites, history, My List and filters.") {
                state.viewers.forEach { v ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ViewerAvatar(v.name, v.color, 32.dp)
                        Text(v.name + if (v.id == me?.id) "  · you" else "", color = SwColors.Text, modifier = Modifier.weight(1f))
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.widthIn(max = 240.dp)) {
                            items(VIEWER_COLORS) { c ->
                                Box(Modifier.size(22.dp).tvFocus(CircleShape).background(Color(parseHexColor(c)!!), CircleShape).clickable { viewModel.recolor(v, c) })
                            }
                        }
                        IconButton(onClick = { renaming = v }) { Icon(Icons.Default.Edit, "Rename ${v.name}") }
                        IconButton(onClick = { deleting = v }) { Icon(Icons.Default.Delete, "Delete ${v.name}", tint = SwColors.Live) }
                    }
                }
                OutlinedButton(onClick = { adding = true }) { Icon(Icons.Default.Add, null); Text(" Add viewer") }
            }
        }
        item {
            Card("${me?.name ?: "Your"}'s channels", "Live TV genres shown to this viewer.") {
                Row { TextButton(onClick = { shownGenres = state.genres.toSet() }) { Text("All") }; TextButton(onClick = { shownGenres = emptySet() }) { Text("None") } }
            }
        }
        items(state.genres, key = { "g-$it" }) { g ->
            CheckRow(g, g in shownGenres) { on -> shownGenres = if (on) shownGenres + g else shownGenres - g }
        }
        item {
            Card("Movies & Series", "Portal categories shown to this viewer.") {
                Row { TextButton(onClick = { shownCats = allCats.toSet() }) { Text("All") }; TextButton(onClick = { shownCats = emptySet() }) { Text("None") } }
            }
        }
        items(allCats, key = { "c-$it" }) { c ->
            CheckRow(c, c in shownCats) { on -> shownCats = if (on) shownCats + c else shownCats - c }
        }
        item {
            Card("Adult content") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Show adult channels and categories", color = SwColors.Text, modifier = Modifier.weight(1f))
                    Switch(checked = showAdult, onCheckedChange = { showAdult = it })
                }
                Button(onClick = { viewModel.saveFilters(hiddenFrom(state.genres, shownGenres), hiddenFrom(allCats, shownCats), showAdult) }, enabled = !state.busy) {
                    Text("Save ${me?.name ?: "viewer"}'s filters")
                }
            }
        }
    }

    renaming?.let { v -> NameDialog("Rename viewer", v.name, onSave = { viewModel.rename(v, it) }, onDismiss = { renaming = null }) }
    if (adding) NameDialog("Add viewer", "", onSave = viewModel::addViewer, onDismiss = { adding = false })
    deleting?.let { v ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${v.name}?") },
            text = { Text("Their favorites, history, My List and filters are deleted too.") },
            confirmButton = { Button(onClick = { deleting = null; viewModel.deleteViewer(v, onOwnViewerDeleted) }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { onChange(!checked) }.padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onChange)
        Text(label, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun NameDialog(title: String, initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") }) },
        confirmButton = { Button(onClick = { onSave(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ── Connection ────────────────────────────────────────────────────────────────

@Composable
private fun ConnectionTab(viewModel: SettingsViewModel, state: SettingsState, serverUrl: String?, onOpenServer: () -> Unit) {
    var editing by remember { mutableStateOf<Profile?>(null) }
    var deleting by remember { mutableStateOf<Profile?>(null) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card("StalkerWeb server", serverUrl ?: "Not set up") {
            OutlinedButton(onClick = onOpenServer) { Icon(Icons.Default.Dns, null); Text(" Change server or access key") }
        }
        Card("IPTV connections", if (state.status?.connected == true) "Connected to ${state.status.portal}" else "Not connected") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = viewModel::reconnect, enabled = !state.busy) { Text("Reconnect") }
                OutlinedButton(onClick = viewModel::disconnect, enabled = !state.busy && state.status?.connected == true) { Text("Disconnect") }
                OutlinedButton(onClick = { editing = Profile(id = "") }) { Icon(Icons.Default.Add, null); Text(" Add") }
            }
            state.profiles.profiles.forEach { p ->
                val active = p.id == state.profiles.activeProfileId
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name.ifBlank { p.portal } + if (active) "  · active" else "", color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${p.portal} · ${p.mac}", color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Button(onClick = { viewModel.connect(p) }, enabled = !state.busy) { Text(if (active) "Reconnect" else "Connect") }
                    IconButton(onClick = { editing = p }) { Icon(Icons.Default.Edit, "Edit ${p.name}") }
                    IconButton(onClick = { deleting = p }) { Icon(Icons.Default.Delete, "Delete ${p.name}", tint = SwColors.Live) }
                }
            }
        }
        Card("Device profile", "The STB identity sent to the portal — change it on the web.") {
            Text("Model: ${state.settings?.stbModel.orEmpty().ifBlank { "MAG250" }}", color = SwColors.Text)
            Text("Firmware: ${state.settings?.firmware.orEmpty().ifBlank { "default" }}", color = SwColors.Text)
        }
    }
    editing?.let { p -> ProfileDialog(p, onSave = { viewModel.saveProfile(it) }, onDismiss = { editing = null }) }
    deleting?.let { p ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${p.name.ifBlank { p.portal }}?") },
            confirmButton = { Button(onClick = { deleting = null; viewModel.deleteProfile(p) }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ProfileDialog(initial: Profile, onSave: (Profile) -> Unit, onDismiss: () -> Unit) {
    var p by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial.id.isBlank()) "Add IPTV connection" else "Edit IPTV connection") },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                @Composable fun field(label: String, value: String, set: (String) -> Unit) =
                    OutlinedTextField(value, set, singleLine = true, label = { Text(label) }, modifier = Modifier.fillMaxWidth())
                field("Name", p.name) { p = p.copy(name = it) }
                field("Portal URL", p.portal) { p = p.copy(portal = it) }
                field("MAC address", p.mac) { p = p.copy(mac = it) }
                field("Timezone", p.timezone) { p = p.copy(timezone = it) }
                field("Language", p.lang) { p = p.copy(lang = it) }
                field("Login", p.login) { p = p.copy(login = it) }
                field("Password", p.password) { p = p.copy(password = it) }
                field("Token", p.token) { p = p.copy(token = it) }
                field("Serial number", p.serialNumber) { p = p.copy(serialNumber = it) }
                field("Device ID", p.deviceId) { p = p.copy(deviceId = it) }
                field("Device ID 2", p.deviceId2) { p = p.copy(deviceId2 = it) }
                field("Signature", p.signature) { p = p.copy(signature = it) }
            }
        },
        confirmButton = { Button(onClick = { onSave(p); onDismiss() }, enabled = p.portal.isNotBlank() && p.mac.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ── Links ─────────────────────────────────────────────────────────────────────

@Composable
private fun LinksTab(state: SettingsState, serverUrl: String?, viewerId: String?) {
    val context = LocalContext.current
    val isTV = rememberIsTV()
    val s = state.settings
    if (serverUrl == null) { Text("Set up a server first.", color = SwColors.Muted); return }
    val links = linksFor(serverUrl, s?.accessShareToken?.takeIf { s.accessEnabled }, viewerId, s?.httpsPort)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Add StalkerWeb to Jellyfin, Plex, Emby, Stremio or any IPTV app with these links. They're this viewer's.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall) }
        items(links, key = { it.label }) { link ->
            Card(link.label, link.hint.ifBlank { null }) {
                Text(link.url, color = SwColors.Text, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { copy(context, link.label, link.url) }) { Icon(Icons.Default.ContentCopy, null); Text(" Copy") }
                    if (!isTV) OutlinedButton(onClick = {
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link.url), link.label))
                    }) { Icon(Icons.Default.Share, null); Text(" Share") }
                }
            }
        }
    }
}

private fun copy(context: Context, label: String, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, text))
    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

// ── Playback ──────────────────────────────────────────────────────────────────

@Composable
private fun PlaybackTab(viewModel: SettingsViewModel, state: SettingsState) {
    val s = state.settings ?: run { Text("Loading…", color = SwColors.Muted); return }
    var vod by remember(s) { mutableStateOf(s.vodEnabled) }
    var epg by remember(s) { mutableStateOf(s.epgEnabled) }
    var buffer by remember(s) { mutableStateOf(s.liveBufferSeconds) }
    var idle by remember(s) { mutableStateOf(s.idleTimeoutMinutes ?: 0) }
    var dir by remember(s) { mutableStateOf(s.downloadDir) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card("Playback & Guide", "Shared by every viewer.") {
            SwitchRow("VOD (movies & series)", vod) { vod = it }
            SwitchRow("Programme guide", epg) { epg = it }
            Text("Live buffer", color = SwColors.Text)
            ChoiceRow(listOf(0, 5, 10, 15, 30, 60), buffer, { if (it == 0) "Off" else "$it s" }) { buffer = it }
            Text("Disconnect when idle", color = SwColors.Text)
            ChoiceRow(listOf(0, 15, 30, 60, 120, 240), idle, { if (it == 0) "Never" else if (it < 60) "$it min" else "${it / 60} h" }) { idle = it }
            OutlinedTextField(dir, { dir = it }, singleLine = true, label = { Text("Download folder (on the server)") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = {
                viewModel.savePlayback(SettingsUpdate(epgEnabled = epg, vodEnabled = vod, downloadDir = dir.trim().ifBlank { null },
                    idleTimeoutMinutes = idle, liveBufferSeconds = buffer))
            }, enabled = !state.busy) { Text("Save") }
        }
    }
}

@Composable
private fun SwitchRow(label: String, on: Boolean, set: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = SwColors.Text, modifier = Modifier.weight(1f))
        Switch(checked = on, onCheckedChange = set)
    }
}

@Composable
private fun ChoiceRow(values: List<Int>, selected: Int, label: (Int) -> String, onPick: (Int) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(values) { v -> Pill(label(v), v == selected, { onPick(v) }) }
    }
}

// ── Logos ─────────────────────────────────────────────────────────────────────

@Composable
private fun LogosTab(viewModel: SettingsViewModel, state: SettingsState) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var word by remember { mutableStateOf("") }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Card("Channel logos", "From your portal, filled in from the iptv-org database when it has none.") {
                state.logos?.stats?.let { st ->
                    Text("${st.dbSize} logos in the database · ${st.matchedChannels} of ${st.totalChannels} channels matched · ${st.overridesCount} overrides", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = viewModel::refreshLogos, enabled = !state.busy) { Text("Refresh logo database") }
            }
        }
        item {
            Card("Logo overrides", "A logo for a channel name, used before anything else.") {
                OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Channel name") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(url, { url = it }, singleLine = true, label = { Text("Logo URL") }, modifier = Modifier.fillMaxWidth())
                Button(onClick = { viewModel.addOverride(name, url); name = ""; url = "" }, enabled = name.isNotBlank() && url.isNotBlank()) { Text("Add override") }
            }
        }
        items(state.logos?.overrides?.entries?.toList().orEmpty(), key = { "o-" + it.key }) { (n, u) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(n, color = SwColors.Text)
                    Text(u, color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = { viewModel.removeOverride(n) }) { Icon(Icons.Default.Close, "Remove override for $n") }
            }
        }
        item {
            Card("Logo strip words", "Removed from channel names before logo matching (e.g. CANADA, so BBC CANADA matches BBC).") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(word, { word = it }, singleLine = true, label = { Text("Word") }, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = { viewModel.addStripWord(word); word = "" }, enabled = word.isNotBlank()) { Text("Add") }
                }
            }
        }
        items(state.stripWords, key = { "w-$it" }) { w ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(w, color = SwColors.Text, modifier = Modifier.weight(1f))
                IconButton(onClick = { viewModel.removeStripWord(w) }) { Icon(Icons.Default.Close, "Remove $w") }
            }
        }
    }
}
```


## Appendix G: Shell and MainActivity wiring

`ui/shell/AppShell.kt`:

1. The signature gains the three new sections and the reminders. `onOpenServer` is no longer used by the shell itself, so remove it from the signature. Settings gets it from MainActivity instead.
   ```kotlin
   fun AppShell(
       vm: ShellViewModel,
       channels: @Composable () -> Unit,
       vod: @Composable () -> Unit,
       guide: @Composable () -> Unit,
       downloads: @Composable () -> Unit,
       settings: @Composable () -> Unit,
       reminders: List<Reminder>,
       onCancelReminder: (String) -> Unit,
       onSwitchViewer: () -> Unit,
       onOpenConnection: () -> Unit,
   ) {
   ```
2. The NavHost routes:
   ```kotlin
   composable(DOWNLOADS.route) { downloads() }
   composable(GUIDE.route) { guide() }
   composable(SETTINGS) { settings() }
   ```
3. Add the bell beside the viewer avatar on both layouts. On the rail, it goes above the avatar. On phones, it goes in the top row, before the avatar's `Box`. Both call `RemindersBell(reminders, onCancelReminder)`.
   ```kotlin
   /** The pending guide reminders, as on the web's header bell. Hidden when there are none. */
   @Composable
   private fun RemindersBell(reminders: List<Reminder>, onCancel: (String) -> Unit) {
       if (reminders.isEmpty()) return
       var open by remember { mutableStateOf(false) }
       val time = remember { java.text.SimpleDateFormat("EEE HH:mm", java.util.Locale.getDefault()) }
       Box {
           IconButton(onClick = { open = true }) {
               BadgedBox(badge = { Badge { Text("${reminders.size}") } }) { Icon(Icons.Default.Notifications, "Reminders") }
           }
           DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
               reminders.sortedBy { it.startTime }.forEach { r ->
                   DropdownMenuItem(
                       text = {
                           Column {
                               Text(r.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                               Text("${r.channelName} · ${time.format(java.util.Date(r.startTime * 1000))}",
                                   style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                           }
                       },
                       trailingIcon = { Icon(Icons.Default.Close, "Cancel reminder") },
                       onClick = { onCancel(r.id) },
                   )
               }
           }
       }
   }
   ```
   New imports: `androidx.compose.material3.Badge`, `androidx.compose.material3.BadgedBox`, `androidx.compose.material.icons.filled.Notifications`, `androidx.compose.material.icons.filled.Close`, `com.stalkerweb.android.data.repo.Reminder`. Drop the imports that are now unused (`EmptyState`, `ViewList`).

`MainActivity.kt`:

1. Add the factories beside the others:
   ```kotlin
   val guideVmFactory = remember {
       object : ViewModelProvider.Factory {
           @Suppress("UNCHECKED_CAST")
           override fun <T : ViewModel> create(modelClass: Class<T>): T =
               GuideViewModel(container.guide, container.live, container.reminders, container.viewers) as T
       }
   }
   val downloadsVmFactory = remember {
       object : ViewModelProvider.Factory {
           @Suppress("UNCHECKED_CAST")
           override fun <T : ViewModel> create(modelClass: Class<T>): T =
               DownloadsViewModel(container.downloads) as T
       }
   }
   val settingsVmFactory = remember {
       object : ViewModelProvider.Factory {
           @Suppress("UNCHECKED_CAST")
           override fun <T : ViewModel> create(modelClass: Class<T>): T =
               SettingsViewModel(container.settings, container.server, container.viewers, container.prefs) as T
       }
   }
   ```
2. The shell call:
   ```kotlin
   composable(Screen.Shell.route) {
       val shellViewModel: ShellViewModel = viewModel(factory = shellVmFactory)
       val reminders by container.reminders.list.collectAsStateWithLifecycle()
       AppShell(
           vm = shellViewModel,
           channels = { /* unchanged */ },
           vod = { /* unchanged */ },
           guide = {
               GuideScreen(
                   viewModel = viewModel(factory = guideVmFactory),
                   onWatch = { channel -> navController.navigate(Screen.Player.go(channel.uniqueId, channel.name)) },
               )
           },
           downloads = { DownloadsScreen(viewModel = viewModel(factory = downloadsVmFactory)) },
           settings = {
               SettingsScreen(
                   viewModel = viewModel(factory = settingsVmFactory),
                   serverUrl = container.server.getServerUrl(),
                   onOpenServer = { navController.navigate(Screen.Setup.go()) },
                   onOwnViewerDeleted = { toPicker(required = true) },
               )
           },
           reminders = reminders,
           onCancelReminder = container.reminders::remove,
           onSwitchViewer   = { toPicker(required = false) },
           onOpenConnection = { navController.navigate(Screen.Portal.route) },
       )
   }
   ```
   The Guide, Downloads and Settings view models are created inside the shell's inner NavHost destinations. Each one lives as long as its tab's back stack entry, and `restoreState` keeps it while you switch tabs.
3. Open a channel from a reminder notification. Add a field:
   ```kotlin
   /** A channel a reminder notification asked to open (uniqueId to name). */
   private val pendingWatch = MutableStateFlow<Pair<String, String>?>(null)

   private fun takeWatchExtra(intent: Intent?) {
       val id = intent?.getStringExtra(ReminderReceiver.EXTRA_CHANNEL_ID) ?: return
       pendingWatch.value = id to intent.getStringExtra(ReminderReceiver.EXTRA_CHANNEL_NAME).orEmpty()
       intent.removeExtra(ReminderReceiver.EXTRA_CHANNEL_ID)
   }

   override fun onNewIntent(intent: Intent) {
       super.onNewIntent(intent)
       takeWatchExtra(intent)
   }
   ```
   In `onCreate`, call `takeWatchExtra(intent)` before `setContent`, but only when `savedInstanceState == null`, so a rotation doesn't replay it. Inside `setContent`, after the startup `LaunchedEffect`:
   ```kotlin
   // A reminder's notification: play its channel once the app is past setup and the picker.
   val watch by pendingWatch.collectAsStateWithLifecycle()
   LaunchedEffect(watch, currentRoute) {
       val (id, name) = watch ?: return@LaunchedEffect
       if (currentRoute != Screen.Shell.route && currentRoute != Screen.Player.route) return@LaunchedEffect
       pendingWatch.value = null
       navController.navigate(Screen.Player.go(id, name))
   }
   ```
   It waits for the shell, so a fresh start still goes through Setup and "Who's watching?" first. A notification tapped while a channel is playing switches to the new one.
4. Add the imports: `GuideScreen`, `GuideViewModel`, `DownloadsScreen`, `DownloadsViewModel`, `SettingsScreen`, `SettingsViewModel`, `ReminderReceiver`, `kotlinx.coroutines.flow.MutableStateFlow`, `android.content.Intent` (if not already there) and `androidx.lifecycle.compose.collectAsStateWithLifecycle`.

`AndroidManifest.xml`: add the receiver from Appendix C inside `<application>`.
