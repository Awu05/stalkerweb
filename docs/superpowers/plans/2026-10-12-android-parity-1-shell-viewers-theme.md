# Android Parity Part 1: Shell, Viewers and Theme — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Android app the web app's structure (an app shell with web-like sections), "Who's watching?" viewers sent as `X-Viewer` on every request, the web's "Midnight Cinema" look, and an always-visible connection name.

**Architecture:**
- The single `ChannelRepository` is split into area repositories (`ServerRepository`, `ViewerRepository`, `LiveRepository`, `VodRepository`) behind an `ApiProvider`. Its OkHttp client adds the access-key and viewer headers and reports access and viewer problems on an `AppEvents` flow.
- `MainActivity` hosts the full-screen routes:
  - Setup
  - viewer picker
  - shell
  - players
  - Portal

  The shell holds Channels, VOD, Downloads, Guide and Settings: a side rail on TVs and wide screens, a bottom bar on phones.
- The theme moves to the web's tokens and the bundled Outfit font, and gains shared tile components.

**Tech Stack:** Kotlin 2.4, Jetpack Compose (BOM 2026.06.00, Material 3), Navigation Compose 2.9, Retrofit 3, OkHttp 5, Moshi 1.15, Coil 2.7, coroutines 1.11. Tests use JUnit 4 on the JVM.

**Spec:** `docs/superpowers/specs/2026-10-12-android-parity-1-shell-viewers-theme-design.md`

## Global Constraints

- **Package:** `com.stalkerweb.android`. New code goes in:
  - `data/api`: Retrofit, models, errors, client
  - `data/repo`: repositories and pure logic
  - `ui/components`
  - `ui/shell`
  - `ui/viewers`
  - `ui/settings`
- **SDK targets:** minSdk 26, compileSdk and targetSdk 37, JVM target 17.
- **Flavors:** `mobile` and `tv` (`BuildConfig.IS_TV`). Layout follows width: rail when `IS_TV || screenWidthDp >= 600`, otherwise a bottom bar.
- **No new runtime dependencies** except the bundled font. Test-only: `junit:junit:4.13.2`.
- **Release builds use R8.** `-keep class com.stalkerweb.android.data.api.** { *; }` already covers new models, so every new Moshi model must go in `data/api`.
- **Colours** are exact, from the spec:

  | Name | Value |
  |------|-------|
  | bg | `#141417` |
  | surface | `#1c1c20` |
  | surface2 | `#232328` |
  | surface3 | `#28282e` |
  | border | `#28282e` |
  | text | `#e8e8ec` |
  | muted | `#9696a0` |
  | primary | `#e8e8ec` |
  | primaryLight | `#ffffff` |
  | live | `#ef4444` |
  | success | `#5bc39d` |
  | heart | `#f43f5e` |
  | warning | `#fbbf24` |

- **Radii:** 8, 10 and 12 dp. **Focus:** a 2 dp white ring and scale 1.03.
- **Viewer rule:** use the saved id only while it still exists. Otherwise the picker is required, even when only one viewer exists.
- **Status poll:** `GET /api/auth/status` every 30 s while the app is started (foreground).
- **Building:** there is no local JDK or Gradle. Compile and unit tests run in CI (`.github/workflows/ci.yml`, job `build-apk`). "Run" steps mean push and read the CI result:
  ```bash
  git push
  gh pr checks <PR> --watch
  ```
  To read a failed job's log:
  ```bash
  gh run view <run> --job <job> --log-failed
  ```
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A wrong or changed access key mustn't lock the app out.** Every request carries the key, and each wrong one counts toward the server's 10-try lockout. After the first `AccessProblem` event, the app must leave the shell (which stops the 30 s poll and section loads) and land on Setup with the server's message. Pinned by the `appEventFor` tests in Task 3 and the event handling in Task 7.
2. **A viewer deleted on another device.** A 409 `{ viewerGone: true }` must clear the saved viewer and show the required picker. It must not loop or crash. Pinned by the `appEventFor` tests in Task 3 and `ViewerRepository.forget()` in Task 7.
3. **A server with no viewers list** (an older server, or `GET /api/viewers` failing). Startup must not block the app. When the list can't be read, skip the picker and carry on with the server's default viewer. Handled in `ViewerRepository.startupChoice()` (Task 4), which falls back to the saved id with no picker. It needs the API, so it's checked by hand in Task 8 rather than unit-tested.
4. **Back on the required picker.** It must not skip the choice: Back leaves the app. Pinned by the `BackHandler` in Task 6.
5. **Odd viewer colours from the server** (null, `"red"`, `"#abc"`, `"#GGGGGG"`). The avatar must fall back to surface3, not crash. Pinned by the `parseHexColor` tests in Task 1.

---

## File map

| File | Responsibility |
|------|----------------|
| `data/repo/ViewerChoice.kt` | `chooseViewer` — startup rule (pure) |
| `data/repo/ConnectionLabel.kt` | `normalizePortal`, `hostOf`, `connectionLabel` (pure) |
| `data/repo/ViewerFilter.kt` | `isAdult`, `languageOf`, `ViewerFilter` (pure) |
| `ui/components/ViewerColors.kt` | `parseHexColor` (pure) |
| `ui/shell/NavLayout.kt` | `NavLayout`, `navLayoutFor` (pure) |
| `data/api/ViewerModels.kt` | `ViewerSummary`, `ViewersResponse`, `ViewerDetails`, `CreateViewerRequest` |
| `data/api/ApiError.kt` | `ApiError`, `ErrorBody`, `apiErrorFor`, `Throwable.toApiError()` |
| `data/api/AppEvents.kt` | `AppEvent`, `AppEvents`, `appEventFor` |
| `data/api/ApiClient.kt` | `requestHeaders`, `ApiClient.create` (OkHttp + interceptors) |
| `data/api/StalkerApi.kt` | + viewer endpoints; `create` delegates to `ApiClient` |
| `data/prefs/AppPrefs.kt` | + `viewerId` |
| `data/repo/ApiProvider.kt` | the current `StalkerApi`, rebuilt when the server changes |
| `data/repo/MediaLinks.kt` | media base, playback token, absolute URLs |
| `data/repo/ServerRepository.kt` | server, key, status, profiles, settings, portal actions |
| `data/repo/ViewerRepository.kt` | viewers list, current viewer, choose/create/forget, filter |
| `data/repo/LiveRepository.kt` | channels, groups, favorites, logos, now/next, streams, history |
| `data/repo/VodRepository.kt` | VOD categories, items, seasons, episodes, stream |
| `data/repo/AppContainer.kt` | builds everything once |
| `data/repository/ChannelRepository.kt` | **deleted** |
| `ui/theme/Theme.kt`, `ui/theme/Type.kt` | web tokens, Outfit, shapes |
| `res/font/outfit.ttf` | bundled variable font (OFL) |
| `ui/components/*.kt` | `Modifier.tvFocus`, `ViewerAvatar`, `EmptyState`, `Pill`, `SectionHeader`, `RowStrip`, `ChannelTile`, `PosterTile` |
| `ui/viewers/ViewerPickerScreen.kt` | "Who's watching?" |
| `ui/shell/ShellViewModel.kt`, `ui/shell/AppShell.kt` | status poll, connection, rail/bottom bar, inner sections |
| `ui/settings/SettingsScreen.kt` | links to Setup and Portal until sub-project 4 |
| `MainActivity.kt` | container, routes, startup, events |

Paths below are relative to `android/app/src/main/java/com/stalkerweb/android/` unless they start with `android/`.

---

### Task 1: Unit-test setup and the pure startup, connection, colour and layout rules

**Files:**
- Modify: `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts`, `.github/workflows/ci.yml`
- Create: `data/repo/ViewerChoice.kt`, `data/repo/ConnectionLabel.kt`, `ui/components/ViewerColors.kt`, `ui/shell/NavLayout.kt`, `data/api/ViewerModels.kt`
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/ViewerChoiceTest.kt`, `.../data/repo/ConnectionLabelTest.kt`, `.../ui/components/ViewerColorsTest.kt`, `.../ui/shell/NavLayoutTest.kt`

**Interfaces:**
- Produces:
  - `data class ViewerSummary(val id: String, val name: String = "", val color: String? = null)`
  - `data class ViewersResponse(val viewers: List<ViewerSummary> = emptyList())`
  - `data class ViewerDetails(id, name, color, isDefault, disabledGenres, disabledLanguages, disabledVodCategories, showAdult)`
  - `data class CreateViewerRequest(val name: String)`
  - `data class ViewerChoice(val id: String?, val needsPicker: Boolean)`
  - `fun chooseViewer(viewers: List<ViewerSummary>, savedId: String?): ViewerChoice`
  - `fun normalizePortal(url: String): String`
  - `fun hostOf(url: String): String`
  - `data class ConnectionLabel(val name: String, val host: String)`
  - `fun connectionLabel(status: StatusResponse?, profiles: List<Profile>): ConnectionLabel?`
  - `fun parseHexColor(hex: String?): Long?`
  - `enum class NavLayout { RAIL, BOTTOM_BAR }`
  - `fun navLayoutFor(widthDp: Int, isTv: Boolean): NavLayout`

- [ ] **Step 1: Add JUnit and the CI test step**

In `android/gradle/libs.versions.toml`, under `[versions]`, add:
```toml
junit = "4.13.2"
```
Under `[libraries]`, add:
```toml
junit                          = { group = "junit",                      name = "junit",                         version.ref = "junit" }
```
In `android/app/build.gradle.kts`, inside `dependencies { … }`, after `debugImplementation(libs.androidx.compose.ui.tooling)`, add:
```kotlin
    testImplementation(libs.junit)
```
In `.github/workflows/ci.yml`, job `build-apk`, add this step directly before the step named `Build debug APKs (mobile + tv)`. Use the same `working-directory` that step uses.
```yaml
      - name: Unit tests
        working-directory: android
        run: gradle :app:testMobileDebugUnitTest
```

- [ ] **Step 2: Write the failing tests**

`android/app/src/test/java/com/stalkerweb/android/data/repo/ViewerChoiceTest.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ViewerSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class ViewerChoiceTest {
    private val a = ViewerSummary("view_a", "Andy")
    private val b = ViewerSummary("view_b", "Sam")

    @Test fun keepsTheSavedViewerWhileItExists() {
        assertEquals(ViewerChoice("view_b", false), chooseViewer(listOf(a, b), "view_b"))
    }

    @Test fun asksWhenNoneIsSavedOrTheSavedOneIsGone() {
        assertEquals(ViewerChoice(null, true), chooseViewer(listOf(a, b), null))
        assertEquals(ViewerChoice(null, true), chooseViewer(listOf(a, b), "view_gone"))
    }

    @Test fun asksEvenWhenThereIsOnlyOne() {
        assertEquals(ViewerChoice(null, true), chooseViewer(listOf(a), null))
    }
}
```

`android/app/src/test/java/com/stalkerweb/android/data/repo/ConnectionLabelTest.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.StatusResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionLabelTest {
    private val status = StatusResponse(connected = true, portal = "http://tv.example.com:8080/c/", mac = "00:1a:79:aa:bb:cc")
    private val home = Profile(id = "p1", name = "Home IPTV", portal = "http://tv.example.com:8080", mac = "00:1A:79:AA:BB:CC")
    private val backup = Profile(id = "p2", name = "Backup", portal = "http://tv.example.com:8080/c", mac = "00:1A:79:00:00:01")

    @Test fun namesTheProfileForThisPortalAndMac() {
        assertEquals(ConnectionLabel("Home IPTV", "tv.example.com:8080"), connectionLabel(status, listOf(backup, home)))
    }

    @Test fun fallsBackToAnyProfileForThePortalThenToTheHost() {
        assertEquals("Backup", connectionLabel(status, listOf(backup))?.name)
        assertEquals(ConnectionLabel("tv.example.com:8080", "tv.example.com:8080"), connectionLabel(status, emptyList()))
    }

    @Test fun isNothingWhileDisconnected() {
        assertNull(connectionLabel(status.copy(connected = false), listOf(home)))
        assertNull(connectionLabel(null, listOf(home)))
    }

    @Test fun normalizesPortals() {
        assertEquals("http://x/c/", normalizePortal("http://x"))
        assertEquals("http://x/c/", normalizePortal(" http://x/c "))
        assertEquals("http://x/c/", normalizePortal("http://x/"))
    }
}
```

`android/app/src/test/java/com/stalkerweb/android/ui/components/ViewerColorsTest.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ViewerColorsTest {
    @Test fun readsSixDigitHex() {
        assertEquals(0xFF5B8DEFL, parseHexColor("#5b8def"))
        assertEquals(0xFF5B8DEFL, parseHexColor("5B8DEF"))
    }

    @Test fun refusesAnythingElse() {
        assertNull(parseHexColor(null))
        assertNull(parseHexColor("red"))
        assertNull(parseHexColor("#abc"))
        assertNull(parseHexColor("#GGGGGG"))
    }
}
```

`android/app/src/test/java/com/stalkerweb/android/ui/shell/NavLayoutTest.kt`:
```kotlin
package com.stalkerweb.android.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class NavLayoutTest {
    @Test fun railOnTvAndWideScreens() {
        assertEquals(NavLayout.RAIL, navLayoutFor(400, isTv = true))
        assertEquals(NavLayout.RAIL, navLayoutFor(840, isTv = false))
        assertEquals(NavLayout.RAIL, navLayoutFor(600, isTv = false))
    }

    @Test fun bottomBarOnPhones() {
        assertEquals(NavLayout.BOTTOM_BAR, navLayoutFor(411, isTv = false))
    }
}
```

- [ ] **Step 3: Write the implementations**

`data/api/ViewerModels.kt`:
```kotlin
package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass

// The server's viewers (backend routes/viewers.js): a summary in lists, the
// details (with that viewer's filters) for the current one.
@JsonClass(generateAdapter = false)
data class ViewerSummary(
    val id: String,
    val name: String = "",
    val color: String? = null,
)

@JsonClass(generateAdapter = false)
data class ViewersResponse(
    val viewers: List<ViewerSummary> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class ViewerDetails(
    val id: String,
    val name: String = "",
    val color: String? = null,
    val isDefault: Boolean = false,
    val disabledGenres: List<String> = emptyList(),
    val disabledLanguages: List<String> = emptyList(),
    val disabledVodCategories: List<String> = emptyList(),
    val showAdult: Boolean = false,
)

@JsonClass(generateAdapter = false)
data class CreateViewerRequest(
    val name: String,
)
```

`data/repo/ViewerChoice.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ViewerSummary

/** Which viewer to start as: [id] when known, otherwise ask ([needsPicker]). */
data class ViewerChoice(val id: String?, val needsPicker: Boolean)

/**
 * The saved viewer while it still exists; otherwise ask "Who's watching?" —
 * even when there's only one, so a new device can pick it or make another.
 * Mirrors frontend/src/lib/viewer.js.
 */
fun chooseViewer(viewers: List<ViewerSummary>, savedId: String?): ViewerChoice =
    if (savedId != null && viewers.any { it.id == savedId }) ViewerChoice(savedId, false)
    else ViewerChoice(null, true)
```

`data/repo/ConnectionLabel.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.StatusResponse
import java.net.URI

/** What the app is connected to: the IPTV connection's name and the portal's address. */
data class ConnectionLabel(val name: String, val host: String)

/** A portal address in one form, for comparing: no trailing /c/, then "/c/" added. */
fun normalizePortal(url: String): String =
    url.trim().replace(Regex("/c/?$"), "").removeSuffix("/") + "/c/"

/** "host:port" (or just the host) of a URL; the URL itself when it can't be read. */
fun hostOf(url: String): String = runCatching {
    val uri = URI(url.trim())
    val host = uri.host ?: return@runCatching url
    if (uri.port > 0) "$host:${uri.port}" else host
}.getOrDefault(url)

/**
 * The saved profile for this portal and MAC (else any for this portal), else
 * just the portal's address. Null when not connected. Mirrors
 * frontend/src/lib/connection.js.
 */
fun connectionLabel(status: StatusResponse?, profiles: List<Profile>): ConnectionLabel? {
    if (status?.connected != true) return null
    val raw = status.portal?.takeIf { it.isNotBlank() } ?: return null
    val host = hostOf(raw)
    val portal = normalizePortal(raw)
    val mac = status.mac.orEmpty().uppercase()
    val match = profiles.firstOrNull { it.portal.isNotBlank() && normalizePortal(it.portal) == portal && it.mac.uppercase() == mac }
        ?: profiles.firstOrNull { it.portal.isNotBlank() && normalizePortal(it.portal) == portal }
    return ConnectionLabel(match?.name?.trim()?.takeIf { it.isNotEmpty() } ?: host, host)
}
```

`ui/components/ViewerColors.kt`:
```kotlin
package com.stalkerweb.android.ui.components

/** A viewer's "#rrggbb" colour as ARGB, or null when it isn't one. */
fun parseHexColor(hex: String?): Long? {
    val digits = hex?.trim()?.removePrefix("#") ?: return null
    if (digits.length != 6) return null
    val rgb = digits.toLongOrNull(16) ?: return null
    return 0xFF000000L or rgb
}
```

`ui/shell/NavLayout.kt`:
```kotlin
package com.stalkerweb.android.ui.shell

/** The shell's navigation: a side rail (TV, wide screens) or a bottom bar (phones). */
enum class NavLayout { RAIL, BOTTOM_BAR }

fun navLayoutFor(widthDp: Int, isTv: Boolean): NavLayout =
    if (isTv || widthDp >= 600) NavLayout.RAIL else NavLayout.BOTTOM_BAR
```

- [ ] **Step 4: Push and check that the unit tests pass in CI**

```bash
git add android/gradle/libs.versions.toml android/app/build.gradle.kts .github/workflows/ci.yml android/app/src
git commit -m "test(android): unit tests in CI; viewer, connection, colour and layout rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/android-shell-viewers
```
Open the PR the first time:
```bash
gh pr create --draft --base main --title "Android parity 1: shell, viewers and theme" --body "Implements docs/superpowers/specs/2026-10-12-android-parity-1-shell-viewers-theme-design.md"
```
Then run `gh pr checks <PR> --watch`. Expected: `build-apk` passes, including the "Unit tests" step with 11 tests.

---

### Task 2: Viewer filter for live channels

**Files:**
- Create: `data/repo/ViewerFilter.kt`
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/ViewerFilterTest.kt`

**Interfaces:**
- Consumes:
  - `ViewerDetails` (Task 1)
  - `Channel(uniqueId, number, name, logo, genre, genreId, legacyId)` from `data/api/Models.kt`
- Produces:
  - `fun isAdult(name: String?): Boolean`
  - `fun languageOf(name: String): String`
  - `data class ViewerFilter(disabledGenres: Set<String>, disabledLanguages: Set<String>, showAdult: Boolean)` with `keepsChannel(Channel)`, `keepsGroup(String)` and `companion fun from(ViewerDetails?)`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ViewerDetails
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerFilterTest {
    private fun ch(name: String, genre: String?) = Channel(uniqueId = name, name = name, genre = genre)
    private val viewer = ViewerDetails(
        id = "view_a",
        disabledGenres = listOf("ENGLISH | SPORTS"),
        disabledLanguages = listOf("french | movies"),   // stored as given; the language part counts
    )
    private val filter = ViewerFilter.from(viewer)

    @Test fun hidesDisabledGenresByExactName() {
        assertFalse(filter.keepsChannel(ch("ESPN", "ENGLISH | SPORTS")))
        assertTrue(filter.keepsChannel(ch("CNN", "ENGLISH | NEWS")))
    }

    @Test fun hidesWholeLanguages() {
        assertFalse(filter.keepsChannel(ch("TF1", " French | News")))
        assertFalse(filter.keepsGroup("FRENCH | KIDS"))
    }

    @Test fun hidesAdultUnlessTheViewerShowsIt() {
        assertFalse(filter.keepsChannel(ch("Late Night", "XXX | NIGHT")))
        assertFalse(filter.keepsChannel(ch("Hot 18+ TV", null)))
        assertTrue(ViewerFilter.from(viewer.copy(showAdult = true)).keepsChannel(ch("Late Night", "XXX | NIGHT")))
    }

    @Test fun keepsChannelsWithNoGenre() {
        assertTrue(filter.keepsChannel(ch("Local", null)))
    }

    @Test fun anUnknownViewerHidesOnlyAdult() {
        val none = ViewerFilter.from(null)
        assertTrue(none.keepsChannel(ch("ESPN", "ENGLISH | SPORTS")))
        assertFalse(none.keepsChannel(ch("x", "ADULT")))
    }
}
```

- [ ] **Step 2: Write the implementation**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ViewerDetails

// Mirrors frontend/src/lib/adultFilter.js.
private val ADULT_PATTERNS = listOf("adult", "for adults", "xxx", "18+", "erotic", "erotica", "hentai", "porn", "sexy", "nsfw")

fun isAdult(name: String?): Boolean {
    val lower = name?.lowercase() ?: return false
    return ADULT_PATTERNS.any { it in lower }
}

/** The language half of a "LANGUAGE | SECTION" name, for comparing (frontend/src/lib/languages.js). */
fun languageOf(name: String): String = name.substringBefore('|').trim().uppercase()

/**
 * What the current viewer hides from live TV: genres by exact name, whole
 * languages, and adult channels unless the viewer shows them. Applied here, as
 * the web's Channels page does, since the server doesn't filter channels.
 */
data class ViewerFilter(
    val disabledGenres: Set<String> = emptySet(),
    val disabledLanguages: Set<String> = emptySet(),
    val showAdult: Boolean = false,
) {
    fun keepsChannel(channel: Channel): Boolean {
        if (!showAdult && (isAdult(channel.genre) || isAdult(channel.name))) return false
        val genre = channel.genre ?: return true
        return genre !in disabledGenres && languageOf(genre) !in disabledLanguages
    }

    fun keepsGroup(name: String): Boolean =
        (showAdult || !isAdult(name)) && name !in disabledGenres && languageOf(name) !in disabledLanguages

    companion object {
        fun from(viewer: ViewerDetails?): ViewerFilter = if (viewer == null) ViewerFilter() else ViewerFilter(
            disabledGenres = viewer.disabledGenres.toSet(),
            disabledLanguages = viewer.disabledLanguages.map(::languageOf).filter { it.isNotEmpty() }.toSet(),
            showAdult = viewer.showAdult,
        )
    }
}
```

- [ ] **Step 3: Commit, push and check CI**

```bash
git add android/app/src
git commit -m "feat(android): the viewer's live TV filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks <PR> --watch
```
Expected: `build-apk` passes, with 16 tests.

---

### Task 3: API client — headers, errors, events and viewer endpoints

**Files:**
- Create: `data/api/ApiError.kt`, `data/api/AppEvents.kt`, `data/api/ApiClient.kt`
- Modify: `data/api/StalkerApi.kt` (add endpoints; `create` delegates)
- Test: `android/app/src/test/java/com/stalkerweb/android/data/api/ApiErrorTest.kt`, `.../data/api/ApiClientTest.kt`

**Interfaces:**
- Consumes: `ViewersResponse`, `ViewerSummary`, `ViewerDetails`, `CreateViewerRequest` (Task 1)
- Produces:
  - `sealed class ApiError : Exception` with:
    - `AccessDenied(message)`
    - `LockedOut(message)`
    - `ViewerGone()`
    - `Unreachable(message)`
    - `Failed(message)`
  - `fun apiErrorFor(code: Int, body: String?): ApiError`
  - `fun Throwable.toApiError(): ApiError`
  - `sealed class AppEvent { object ViewerGone; data class AccessProblem(val message: String) }`
  - `fun appEventFor(code: Int, body: String?): AppEvent?`
  - `class AppEvents { val events: SharedFlow<AppEvent>; fun emit(e: AppEvent) }`
  - `fun requestHeaders(accessKey: String?, viewerId: String?): Map<String, String>`
  - `object ApiClient { fun create(baseUrl: String, accessKey: () -> String?, viewerId: () -> String?, events: AppEvents?): StalkerApi }`
  - `StalkerApi.getViewers(): ViewersResponse`
  - `StalkerApi.createViewer(CreateViewerRequest): ViewerSummary`
  - `StalkerApi.getMyViewer(): ViewerDetails`

- [ ] **Step 1: Write the failing tests**

`android/app/src/test/java/com/stalkerweb/android/data/api/ApiErrorTest.kt`:
```kotlin
package com.stalkerweb.android.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ApiErrorTest {
    @Test fun accessGateRefusalsAreAccessDenied() {
        val e = apiErrorFor(401, """{"error":"Access key required.","accessRequired":true}""")
        assertTrue(e is ApiError.AccessDenied)
        assertEquals("Access key required.", e.message)
    }

    @Test fun lockoutsKeepTheServersWait() {
        val e = apiErrorFor(429, """{"error":"Too many wrong access keys — try again in 30 minutes."}""")
        assertTrue(e is ApiError.LockedOut)
        assertEquals("Too many wrong access keys — try again in 30 minutes.", e.message)
    }

    @Test fun aDeletedViewerIsViewerGone() {
        assertTrue(apiErrorFor(409, """{"error":"This viewer was deleted.","viewerGone":true}""") is ApiError.ViewerGone)
    }

    @Test fun otherFailuresKeepTheServersMessage() {
        val e = apiErrorFor(500, """{"error":"The viewers could not be saved."}""")
        assertTrue(e is ApiError.Failed)
        assertEquals("The viewers could not be saved.", e.message)
        assertEquals("HTTP 502", apiErrorFor(502, "<html>bad gateway</html>").message)
        // A portal's own 401 (no accessRequired) is not an access-key problem.
        assertTrue(apiErrorFor(401, """{"error":"Portal refused the MAC"}""") is ApiError.Failed)
    }

    @Test fun networkFailuresAreUnreachable() {
        assertTrue(IOException("timeout").toApiError() is ApiError.Unreachable)
    }

    @Test fun onlyAccessAndViewerProblemsBecomeAppEvents() {
        assertEquals(AppEvent.ViewerGone, appEventFor(409, """{"viewerGone":true}"""))
        assertEquals(AppEvent.AccessProblem("Access key required."), appEventFor(401, """{"error":"Access key required.","accessRequired":true}"""))
        assertTrue(appEventFor(429, """{"error":"Too many"}""") is AppEvent.AccessProblem)
        assertNull(appEventFor(401, """{"error":"Portal refused the MAC"}"""))
        assertNull(appEventFor(500, null))
    }
}
```

`android/app/src/test/java/com/stalkerweb/android/data/api/ApiClientTest.kt`:
```kotlin
package com.stalkerweb.android.data.api

import org.junit.Assert.assertEquals
import org.junit.Test

class ApiClientTest {
    @Test fun sendsTheKeyAndTheViewerWhenSet() {
        assertEquals(
            mapOf("Authorization" to "Bearer secret-key-123", "X-Viewer" to "view_a"),
            requestHeaders("secret-key-123", "view_a"),
        )
    }

    @Test fun leavesOutWhatIsNotSet() {
        assertEquals(mapOf("X-Viewer" to "view_a"), requestHeaders(null, "view_a"))
        assertEquals(mapOf("Authorization" to "Bearer k"), requestHeaders("k", " "))
        assertEquals(emptyMap<String, String>(), requestHeaders("", null))
    }
}
```

- [ ] **Step 2: Write `ApiError.kt`**

```kotlin
package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import retrofit2.HttpException
import java.io.IOException

/** What went wrong talking to the server, with the server's own message where it gave one. */
sealed class ApiError(message: String) : Exception(message) {
    /** The access gate refused the key (401 with accessRequired). */
    class AccessDenied(message: String) : ApiError(message)
    /** Too many wrong keys from here (429); the message says how long to wait. */
    class LockedOut(message: String) : ApiError(message)
    /** This device's viewer was deleted (409 with viewerGone). */
    class ViewerGone : ApiError("This viewer was deleted. Pick who is watching.")
    /** No answer at all: wrong address, server down, no network. */
    class Unreachable(message: String) : ApiError(message)
    class Failed(message: String) : ApiError(message)
}

/** The JSON error body the server sends ({ error, accessRequired, viewerGone }). */
@JsonClass(generateAdapter = false)
data class ErrorBody(
    val error: String? = null,
    val accessRequired: Boolean? = null,
    val viewerGone: Boolean? = null,
)

private val errorAdapter = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build().adapter(ErrorBody::class.java)

internal fun parseErrorBody(body: String?): ErrorBody =
    body?.let { runCatching { errorAdapter.fromJson(it) }.getOrNull() } ?: ErrorBody()

fun apiErrorFor(code: Int, body: String?): ApiError {
    val b = parseErrorBody(body)
    val message = b.error?.takeIf { it.isNotBlank() }
    return when {
        code == 409 && b.viewerGone == true -> ApiError.ViewerGone()
        code == 401 && b.accessRequired == true -> ApiError.AccessDenied(message ?: "Access key required.")
        code == 429 -> ApiError.LockedOut(message ?: "Too many wrong access keys — try again later.")
        else -> ApiError.Failed(message ?: "HTTP $code")
    }
}

/** Any failure from a request, as an [ApiError]. Reads (and so uses up) an HTTP error's body. */
fun Throwable.toApiError(): ApiError = when (this) {
    is ApiError -> this
    is HttpException -> apiErrorFor(code(), runCatching { response()?.errorBody()?.string() }.getOrNull())
    is IOException -> ApiError.Unreachable("Can't reach the server.")
    else -> ApiError.Failed(message ?: "Something went wrong.")
}
```

- [ ] **Step 3: Write `AppEvents.kt`**

```kotlin
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
```

- [ ] **Step 4: Write `ApiClient.kt`**

```kotlin
package com.stalkerweb.android.data.api

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

/** The headers every request carries: the access key and the chosen viewer, when set. */
fun requestHeaders(accessKey: String?, viewerId: String?): Map<String, String> = buildMap {
    if (!accessKey.isNullOrBlank()) put("Authorization", "Bearer $accessKey")
    if (!viewerId.isNullOrBlank()) put("X-Viewer", viewerId)
}

object ApiClient {
    /**
     * [accessKey] and [viewerId] are read on every request, so a viewer switch
     * applies to the next one without rebuilding the client. [events], when
     * given, hears about access-key and deleted-viewer answers (AppEvent).
     */
    fun create(baseUrl: String, accessKey: () -> String?, viewerId: () -> String?, events: AppEvents?): StalkerApi {
        val moshi = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val builder = chain.request().newBuilder()
                requestHeaders(accessKey(), viewerId()).forEach { (k, v) -> builder.header(k, v) }
                val response = chain.proceed(builder.build())
                if (events != null && response.code in setOf(401, 409, 429)) {
                    appEventFor(response.code, response.peekBody(64 * 1024).string())?.let(events::emit)
                }
                response
            }
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
        return Retrofit.Builder()
            .baseUrl(if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/")
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(StalkerApi::class.java)
    }
}
```

- [ ] **Step 5: Add the viewer endpoints and route `StalkerApi.create` through `ApiClient`**

In `data/api/StalkerApi.kt`, add these inside the interface after `setActiveProfile`:
```kotlin
    // ── Viewers ───────────────────────────────────────────────────────────────
    @GET("api/viewers")
    suspend fun getViewers(): ViewersResponse

    @POST("api/viewers")
    suspend fun createViewer(@Body body: CreateViewerRequest): ViewerSummary

    @GET("api/viewers/me")
    suspend fun getMyViewer(): ViewerDetails
```
Replace the whole `companion object { … }` with:
```kotlin
    companion object {
        /** A client for [baseUrl] with a fixed [accessKey] and no viewer — for testing a server in Setup. */
        fun create(baseUrl: String, accessKey: String? = null): StalkerApi =
            ApiClient.create(baseUrl, { accessKey }, { null }, events = null)
    }
```
Then delete the imports that are now unused from `StalkerApi.kt`: `Moshi`, `KotlinJsonAdapterFactory`, `OkHttpClient`, `HttpLoggingInterceptor`, `Retrofit`, `MoshiConverterFactory` and `TimeUnit`.

- [ ] **Step 6: Commit, push and check CI**

```bash
git add android/app/src
git commit -m "feat(android): API client with viewer header, typed errors and app events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks <PR> --watch
```
Expected: `build-apk` passes, with 24 tests.

---

### Task 4: Split the repository; viewers drive the channel filter

**Files:**
- Create: `data/repo/ApiProvider.kt`, `data/repo/MediaLinks.kt`, `data/repo/ServerRepository.kt`, `data/repo/ViewerRepository.kt`, `data/repo/LiveRepository.kt`, `data/repo/VodRepository.kt`, `data/repo/AppContainer.kt`
- Modify: `data/prefs/AppPrefs.kt`, `ui/channels/ChannelViewModel.kt`, `ui/player/PlayerViewModel.kt`, `ui/vod/VodViewModel.kt`, `ui/vod/VodPlayerViewModel.kt`, `ui/portal/PortalViewModel.kt`, `ui/setup/SetupScreen.kt`, `MainActivity.kt` (construction only; routes change in Task 7)
- Delete: `data/repository/ChannelRepository.kt`

**Interfaces:**
- Consumes:
  - `ApiClient.create`, `AppEvents`, `toApiError()` (Task 3)
  - `ViewerFilter` (Task 2)
  - `chooseViewer`, `ViewerChoice` (Task 1)
- Produces (method names kept from `ChannelRepository`, so ViewModel bodies only change their receiver):
  - `ApiProvider(prefs, events)`: `get(): StalkerApi`, `rebuild()`
  - `ServerRepository(prefs, apis)`:
    - `getServerUrl()`, `getAccessKey()`, `setServerUrl(url, key)`, `testServerUrl(url, key)`, `testConnection()`
    - `disconnectPortal()`, `reconnectPortal()`, `getPortalConfig()`, `getProfiles()`, `setActiveProfile(id)`, `connectProfile(profile)`
    - `getSettings(): SettingsResponse?`
  - `ViewerRepository(prefs, apis)`:
    - `current: StateFlow<ViewerDetails?>`, `changes: StateFlow<Int>`
    - `savedViewerId()`, `list()`, `startupChoice(): ViewerChoice`
    - `choose(id)`, `create(name): ViewerSummary`, `refresh(): ViewerDetails?`, `filter(): ViewerFilter`, `forget()`
  - `LiveRepository(prefs, apis, links, viewers)`:
    - `getChannels()`, `getCachedChannels()`, `getCachedLogoMap()`, `getGroups()`, `getLogoMap()`
    - `getFavoriteIds()`, `addFavorite(id)`, `removeFavorite(id)`, `getNowNext()`
    - `defaultStreamUrl(id)`, `resolveStream(id): StreamInfo`, `getStreamOverride(id)`, `setStreamOverride(id, url)`
    - `pushWatched(channel, logo)`, `getWatched()`
  - `VodRepository(apis, links)`: `getVodCategories(type)`, `getVodItems(type, category, page, search)`, `getVodSeasons(id)`, `getVodEpisodes(show, season)`, `resolveVodStreamUrl(...)`
  - `AppContainer(context)`: `prefs`, `events`, `apis`, `server`, `viewers`, `live`, `vod`
  - `data class StreamInfo(val url: String, val type: String)`, now in `data/repo`
- Not created here: the spec's empty `WatchRepository` placeholder. Sub-project 2 creates it when it first needs it.

- [ ] **Step 1: Add `viewerId` to `AppPrefs`**

In `data/prefs/AppPrefs.kt`, after the `shareToken` property, add:
```kotlin
    // The viewer this device watches as (Settings → Viewers on the web), sent as
    // X-Viewer. Cleared when the server or access key changes, or the viewer is
    // deleted — then "Who's watching?" asks again.
    var viewerId: String?
        get() = prefs.getString(KEY_VIEWER_ID, null)
        set(value) = prefs.edit().putString(KEY_VIEWER_ID, value).apply()
```
In its `companion object`, next to `KEY_ACCESS_KEY`, add:
```kotlin
        private const val KEY_VIEWER_ID       = "viewer_id"
```

- [ ] **Step 2: Write `ApiProvider.kt` and `MediaLinks.kt`**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ApiClient
import com.stalkerweb.android.data.api.ApiError
import com.stalkerweb.android.data.api.AppEvents
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.prefs.AppPrefs

/** The client for the saved server — rebuilt when the server changes; the key and viewer are read per request. */
class ApiProvider(private val prefs: AppPrefs, private val events: AppEvents) {
    @Volatile private var api: StalkerApi? = null

    init { rebuild() }

    fun rebuild() {
        val url = prefs.serverUrl
        api = url?.let {
            runCatching { ApiClient.create(it, { prefs.accessKey }, { prefs.viewerId }, events) }.getOrElse {
                // A stored URL that can't be used (data corruption): forget it so
                // the app lands on Setup instead of failing on every launch.
                prefs.serverUrl = null
                null
            }
        }
    }

    fun get(): StalkerApi = api ?: throw ApiError.Failed("No server is set up.")
}
```

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.prefs.AppPrefs

/**
 * Links the player, Coil or a cast device open. They can't send the access-key
 * header, so with a key set the links carry the server's playback-only token
 * (/k/<token>) instead.
 */
class MediaLinks(private val prefs: AppPrefs, private val apis: ApiProvider) {
    fun base(): String {
        val base = prefs.serverUrl?.trimEnd('/') ?: ""
        return prefs.shareToken?.let { "$base/k/$it" } ?: base
    }

    /** Fetches the playback token when a key is set and it isn't known yet. */
    suspend fun ensureShareToken() {
        if (prefs.accessKey.isNullOrBlank() || prefs.shareToken != null) return
        runCatching { apis.get().getSettings() }.getOrNull()?.let { prefs.shareToken = it.accessShareToken }
    }

    /** The server's relative image/stream URLs made absolute (Coil and ExoPlayer need that). */
    fun absolute(url: String?): String? = when {
        url.isNullOrBlank() -> url
        url.startsWith("http", ignoreCase = true) -> url
        else -> "${base()}$url"
    }
}
```

- [ ] **Step 3: Write `ServerRepository.kt`**

Move the code from `ChannelRepository` unchanged except where noted:
```kotlin
package com.stalkerweb.android.data.repo

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
class ServerRepository(private val prefs: AppPrefs, private val apis: ApiProvider) {

    fun getServerUrl(): String? = prefs.serverUrl
    fun getAccessKey(): String? = prefs.accessKey

    /**
     * Saves the address and key and rebuilds the client. A different server or
     * key forgets this device's viewer (the picker asks again) and the cached
     * channel list (so the old server's channels don't flash).
     */
    fun setServerUrl(url: String, accessKey: String? = null) {
        val normalized = url.trimEnd('/')
        val key = accessKey?.trim()?.ifEmpty { null }
        val serverChanged = normalized != prefs.serverUrl
        if (serverChanged) prefs.clearChannelCache()
        if (serverChanged || key != prefs.accessKey) {
            prefs.shareToken = null
            prefs.viewerId = null
        }
        prefs.serverUrl = normalized
        prefs.accessKey = key
        apis.rebuild()
    }

    /** Tests a candidate server without saving it, so a failed edit never leaves the app on a broken server. */
    suspend fun testServerUrl(url: String, accessKey: String? = null): StatusResponse =
        StalkerApi.create(url.trimEnd('/'), accessKey?.trim()?.ifEmpty { null }).getStatus()

    suspend fun testConnection(): StatusResponse = apis.get().getStatus()

    suspend fun disconnectPortal(): PortalActionResponse = apis.get().disconnectPortal()
    suspend fun reconnectPortal(): PortalActionResponse = apis.get().reconnectPortal()
    suspend fun getPortalConfig(): PortalConfigResponse? = runCatching { apis.get().getPortalConfig() }.getOrNull()

    suspend fun getProfiles(): ProfilesResponse =
        runCatching { apis.get().getProfiles() }.getOrDefault(ProfilesResponse())

    suspend fun setActiveProfile(id: String?) =
        runCatching { apis.get().setActiveProfile(SetActiveProfileRequest(id)) }

    // (copy connectProfile from ChannelRepository verbatim, with requireApi() → apis.get())

    /** The server's settings (VOD and guide switches, playback token), or null when unreachable. */
    suspend fun getSettings(): SettingsResponse? = runCatching {
        apis.get().getSettings().also { if (!prefs.accessKey.isNullOrBlank()) prefs.shareToken = it.accessShareToken }
    }.getOrNull()
}
```
Copy `connectProfile(profile: Profile)` from `ChannelRepository` lines 175–200 into the marked spot, replacing `requireApi()` with `apis.get()`. Keep the KDoc above it.

- [ ] **Step 4: Write `ViewerRepository.kt`**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.CreateViewerRequest
import com.stalkerweb.android.data.api.ViewerDetails
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.prefs.AppPrefs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Who is watching on this device: the list, the current viewer and its filters. */
class ViewerRepository(private val prefs: AppPrefs, private val apis: ApiProvider) {
    private val _current = MutableStateFlow<ViewerDetails?>(null)
    /** The current viewer's details, once read from the server. */
    val current: StateFlow<ViewerDetails?> = _current.asStateFlow()

    private val _changes = MutableStateFlow(0)
    /** Goes up on every switch or forget — screens holding a viewer's data reload on it. */
    val changes: StateFlow<Int> = _changes.asStateFlow()

    fun savedViewerId(): String? = prefs.viewerId

    suspend fun list(): List<ViewerSummary> = apis.get().getViewers().viewers

    /**
     * Who to start as. When the list can't be read (an older server without
     * viewers, or a hiccup), don't block the app: carry on as the server's
     * default viewer.
     */
    suspend fun startupChoice(): ViewerChoice =
        runCatching { chooseViewer(list(), prefs.viewerId) }.getOrElse { ViewerChoice(prefs.viewerId, false) }

    suspend fun choose(id: String) {
        prefs.viewerId = id
        _current.value = null
        _changes.value += 1
        refresh()
    }

    /** Makes a viewer (the server checks the name) and switches to it. Throws with the server's message. */
    suspend fun create(name: String): ViewerSummary {
        val viewer = apis.get().createViewer(CreateViewerRequest(name.trim()))
        choose(viewer.id)
        return viewer
    }

    suspend fun refresh(): ViewerDetails? =
        runCatching { apis.get().getMyViewer() }.getOrNull().also { _current.value = it }

    /** The current viewer's live TV filter, reading the viewer first if needed. */
    suspend fun filter(): ViewerFilter = ViewerFilter.from(_current.value ?: refresh())

    /** This device's viewer is no more (deleted elsewhere): forget it. */
    fun forget() {
        prefs.viewerId = null
        _current.value = null
        _changes.value += 1
    }
}
```

- [ ] **Step 5: Write `LiveRepository.kt` and `VodRepository.kt`**

`LiveRepository.kt`: copy these members of `ChannelRepository` with their KDoc, replacing `requireApi()` with `apis.get()`, `mediaBase()` with `links.base()` and `ensureShareToken()` with `links.ensureShareToken()`:
- `defaultStreamUrl`
- `resolveStream`
- `inferStreamType`
- `getStreamOverride`, `setStreamOverride`
- `getCachedChannels`, `getCachedLogoMap`
- `getLogoMap`
- `getFavoriteIds`, `addFavorite`, `removeFavorite`
- `getNowNext`
- `pushWatched`, `getWatched`

Then add the filtering methods, which replace the old profile filter:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.AddFavoriteRequest
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.prefs.WatchedChannel

/** A resolved live stream: its absolute URL and the engine hint for the player. */
data class StreamInfo(val url: String, val type: String)

/** Live TV: channels and groups (filtered for the current viewer), favorites, logos, now/next, streams. */
class LiveRepository(
    private val prefs: AppPrefs,
    private val apis: ApiProvider,
    private val links: MediaLinks,
    private val viewers: ViewerRepository,
) {
    suspend fun getChannels(): List<Channel> {
        val filter = viewers.filter()
        val channels = apis.get().getChannels().channels
            .filter(filter::keepsChannel)
            // The channel and player lists key by uniqueId; a portal returning the
            // same id twice would crash them with "Key was already used".
            .distinctBy { it.uniqueId }
        // Runs off the network list, which is the only place legacyId appears —
        // the on-disk cache doesn't store it. One-shot; see AppPrefs.
        prefs.migrateLegacyChannelIds(channels)
        prefs.cacheChannels(channels)
        return channels
    }

    suspend fun getGroups(): List<Group> = runCatching {
        val filter = viewers.filter()
        apis.get().getGroups().groups
            // Stalker's catch-all pseudo-genre (id "*"): the UI has its own "All"
            // chip, and no channel carries genreId "*".
            .filter { it.id != ALL_GENRES_ID && filter.keepsGroup(it.name) }
    }.getOrDefault(emptyList())

    // … the members copied from ChannelRepository go here …

    private companion object { const val ALL_GENRES_ID = "*" }
}
```

`VodRepository.kt`: copy `getVodCategories`, `getVodItems`, `getVodSeasons`, `getVodEpisodes` and `resolveVodStreamUrl` verbatim. Replace `requireApi()` with `apis.get()`, `ensureShareToken()` with `links.ensureShareToken()`, `absoluteUrl(x)` with `links.absolute(x)` and `mediaBase()` with `links.base()`.
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItemsResponse
import com.stalkerweb.android.data.api.VodSeason

/** Movies and series: categories, titles, seasons, episodes and streams. */
class VodRepository(private val apis: ApiProvider, private val links: MediaLinks) {
    // … the five members copied from ChannelRepository …
}
```

- [ ] **Step 6: Write `AppContainer.kt`**

```kotlin
package com.stalkerweb.android.data.repo

import android.content.Context
import com.stalkerweb.android.data.api.AppEvents
import com.stalkerweb.android.data.prefs.AppPrefs

/** Builds the app's data layer once (MainActivity); screens take what they need from it. */
class AppContainer(context: Context) {
    val prefs = AppPrefs(context)
    val events = AppEvents()
    val apis = ApiProvider(prefs, events)
    private val links = MediaLinks(prefs, apis)
    val server = ServerRepository(prefs, apis)
    val viewers = ViewerRepository(prefs, apis)
    val live = LiveRepository(prefs, apis, links, viewers)
    val vod = VodRepository(apis, links)
}
```

- [ ] **Step 7: Point the ViewModels and Setup at the new repositories, and reload on a viewer switch**

- **`ChannelViewModel`**
  - Change the constructor to `class ChannelViewModel(private val live: LiveRepository, private val server: ServerRepository, private val viewers: ViewerRepository) : ViewModel()`.
  - Replace `repository.getServerUrl()` with `server.getServerUrl()`, and every other `repository.` with `live.`.
  - At the end of `init { … }`, add:
    ```kotlin
        // Another viewer: their favorites and filters — read the lists again.
        viewModelScope.launch { viewers.changes.drop(1).collect { load(reset = true) } }
    ```
  - Imports: `kotlinx.coroutines.flow.drop`, and the three `com.stalkerweb.android.data.repo.*` classes. Remove the `data.repository.ChannelRepository` import.
- **`PlayerViewModel`:** change the `repository: ChannelRepository` constructor parameter to `live: LiveRepository`, and replace every `repository.` with `live.`.
- **`VodViewModel`**
  - Change the constructor to `class VodViewModel(private val vod: VodRepository, private val viewers: ViewerRepository) : ViewModel()`.
  - Replace every `repository.` with `vod.`.
  - Add this `init` block after the field declarations:
    ```kotlin
    init {
        // Another viewer: start the section again (their hidden categories differ).
        viewModelScope.launch {
            viewers.changes.drop(1).collect {
                _state.value = VodUiState(type = _state.value.type)
                loadCategories()
            }
        }
    }
    ```
- **`VodPlayerViewModel`:** change `repository: ChannelRepository` to `vod: VodRepository`, and replace every `repository.` with `vod.`.
- **`PortalViewModel`:** change it to `class PortalViewModel(private val server: ServerRepository)`, and replace every `repository.` with `server.`.
- **`SetupScreen`:** change the parameter `repository: ChannelRepository` to `server: ServerRepository`, and replace every `repository.` with `server.`.
- **`MainActivity.onCreate`**
  - Replace
    ```kotlin
    val prefs = AppPrefs(this)
    val repository = ChannelRepository(prefs).also { it.initFromPrefs() }
    ```
    with
    ```kotlin
    val container = (application as StalkerWebApp).container
    ```
  - Update the factories:
    - `ChannelViewModel(container.live, container.server, container.viewers)`
    - `PlayerViewModel(application, container.live)`
    - `VodViewModel(container.vod, container.viewers)`
    - `VodPlayerViewModel(application, container.vod)`
    - `PortalViewModel(container.server)`
  - `SetupScreen(server = container.server, …)`.
  - `repository.getServerUrl()` becomes `container.server.getServerUrl()`.
  - `repository.testConnection()` becomes `container.server.testConnection()`.
  - `repository.isVodEnabled()` becomes `container.server.getSettings()?.vodEnabled == true`.
- **`StalkerWebApp`:** after `CrashReporter.install(this)`, add
  ```kotlin
  container = AppContainer(this)
  ```
  and declare
  ```kotlin
  lateinit var container: AppContainer
      private set
  ```

- [ ] **Step 8: Delete the old repository**

```bash
git rm android/app/src/main/java/com/stalkerweb/android/data/repository/ChannelRepository.kt
grep -rn "ChannelRepository\|data.repository" android/app/src/main/java
```
Expected: `grep` prints nothing.

- [ ] **Step 9: Commit, push and check CI**

```bash
git add -A android
git commit -m "refactor(android): repositories per area; the viewer's filter for live TV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks <PR> --watch
```
Expected: `build-apk` passes. It compiles both flavors and the 24 tests pass. On a compile error, read `gh run view <run> --job <job> --log-failed`, fix the named lines, and push again.

---

### Task 5: Theme, the Outfit font and shared components

**Files:**
- Create: `android/app/src/main/res/font/outfit.ttf`, `android/licenses/Outfit-OFL.txt`, `ui/components/Focus.kt`, `ui/components/ViewerAvatar.kt`, `ui/components/EmptyState.kt`, `ui/components/Pill.kt`, `ui/components/SectionHeader.kt`, `ui/components/RowStrip.kt`, `ui/components/ChannelTile.kt`, `ui/components/PosterTile.kt`
- Modify: `ui/theme/Theme.kt`, `ui/theme/Type.kt`, `ui/vod/VodScreen.kt` (`VodCard` → `PosterTile`), `MainActivity.kt` (background)

**Interfaces:**
- Consumes: `parseHexColor` (Task 1), `ViewerSummary` (Task 1), `Channel`, `NowNextEntry`
- Produces:
  - `object SwColors` with every colour in Global Constraints
  - `val Outfit: FontFamily`
  - `fun Modifier.tvFocus(shape: Shape = RoundedCornerShape(10.dp)): Modifier`
  - `@Composable ViewerAvatar(name: String, color: String?, size: Dp, modifier)`
  - `@Composable EmptyState(icon: ImageVector, title: String, message: String?, action: (@Composable () -> Unit)?)`
  - `@Composable Pill(text: String, selected: Boolean, onClick: () -> Unit, leading: ImageVector? = null)`
  - `@Composable SectionHeader(icon: ImageVector, title: String, count: Int? = null, expanded: Boolean? = null, onToggle: (() -> Unit)? = null)`
  - `@Composable <T> RowStrip(items: List<T>, key: (T) -> Any, itemWidth: Dp, content: @Composable (T) -> Unit)`
  - `@Composable ChannelTile(channel: Channel, logoUrl: String?, isFavorite: Boolean, nowNext: NowNextEntry?, errors: Int, onClick: () -> Unit, onToggleFavorite: (() -> Unit)?, onEdit: (() -> Unit)?, modifier)`
  - `@Composable PosterTile(title: String, year: String, posterUrl: String?, isHD: Boolean, onClick: () -> Unit, modifier, bookmarked: Boolean? = null, onBookmark: (() -> Unit)? = null, onDownload: (() -> Unit)? = null)`

- [ ] **Step 1: Bundle the Outfit font and its licence**

```bash
mkdir -p android/app/src/main/res/font android/licenses
curl -fL -o android/app/src/main/res/font/outfit.ttf "https://github.com/google/fonts/raw/main/ofl/outfit/Outfit%5Bwght%5D.ttf"
curl -fL -o android/licenses/Outfit-OFL.txt "https://github.com/google/fonts/raw/main/ofl/outfit/OFL.txt"
file android/app/src/main/res/font/outfit.ttf
```
Expected: `TrueType Font data`.

- [ ] **Step 2: Replace `Theme.kt`**

```kotlin
package com.stalkerweb.android.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** The web app's "Midnight Cinema" tokens (frontend/src/index.css), by the same names. */
object SwColors {
    val Bg           = Color(0xFF141417)
    val Surface      = Color(0xFF1C1C20)
    val Surface2     = Color(0xFF232328)
    val Surface3     = Color(0xFF28282E)
    val Border       = Color(0xFF28282E)
    val Text         = Color(0xFFE8E8EC)
    val Muted        = Color(0xFF9696A0)
    val Primary      = Color(0xFFE8E8EC)
    val PrimaryLight = Color(0xFFFFFFFF)
    val Live         = Color(0xFFEF4444)
    val Success      = Color(0xFF5BC39D)
    val Heart        = Color(0xFFF43F5E)
    val Warning      = Color(0xFFFBBF24)
}

private val DarkColors = darkColorScheme(
    primary                 = SwColors.Primary,
    onPrimary               = SwColors.Bg,
    primaryContainer        = SwColors.Surface3,
    onPrimaryContainer      = SwColors.PrimaryLight,
    secondary               = SwColors.Muted,
    onSecondary             = SwColors.Bg,
    tertiary                = SwColors.Success,
    onTertiary              = SwColors.Bg,
    background              = SwColors.Bg,
    onBackground            = SwColors.Text,
    surface                 = SwColors.Surface,
    onSurface               = SwColors.Text,
    surfaceVariant          = SwColors.Surface2,
    onSurfaceVariant        = SwColors.Muted,
    surfaceContainerLowest  = SwColors.Bg,
    surfaceContainerLow     = SwColors.Surface,
    surfaceContainer        = SwColors.Surface2,
    surfaceContainerHigh    = SwColors.Surface3,
    surfaceContainerHighest = Color(0xFF303036),
    outline                 = SwColors.Border,
    outlineVariant          = Color(0xFF1F1F24),
    error                   = SwColors.Live,
    onError                 = Color.White,
)

/** The web's --radius-sm / -md / -lg. */
private val SwShapes = Shapes(
    small  = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(10.dp),
    large  = RoundedCornerShape(12.dp),
)

@Composable
fun StalkerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, typography = StalkerTypography, shapes = SwShapes) {
        // MaterialTheme doesn't provide LocalContentColor; screens with a
        // transparent Scaffold would otherwise get black text. Give the theme's.
        CompositionLocalProvider(LocalContentColor provides SwColors.Text, content = content)
    }
}
```

- [ ] **Step 3: Use Outfit for all text in `Type.kt`**

Keep the existing `TextStyle` sizes, weights and letter-spacing, but build them on Outfit. Replace the file's body below the imports with:
```kotlin
package com.stalkerweb.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.stalkerweb.android.R

// The web app's font (Outfit, OFL — android/licenses/Outfit-OFL.txt), bundled
// so it works offline and on TV boxes without Google services. One variable
// file, one entry per weight used.
@OptIn(ExperimentalTextApi::class)
private fun outfit(weight: Int) =
    Font(R.font.outfit, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

val Outfit = FontFamily(outfit(400), outfit(500), outfit(600), outfit(700))

private val base = Typography()
private fun TextStyle.outfit() = copy(fontFamily = Outfit)

val StalkerTypography = Typography(
    displayLarge   = base.displayLarge.outfit(),
    displayMedium  = base.displayMedium.outfit(),
    displaySmall   = base.displaySmall.outfit(),
    headlineLarge  = base.headlineLarge.outfit(),
    headlineMedium = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.Bold, fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = (-0.5).sp),
    headlineSmall  = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.4).sp),
    titleLarge     = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp, letterSpacing = (-0.3).sp),
    titleMedium    = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp, letterSpacing = (-0.1).sp),
    titleSmall     = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge      = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.1.sp),
    bodyMedium     = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
    bodySmall      = base.bodySmall.outfit(),
    labelLarge     = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
    labelMedium    = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.4.sp),
    labelSmall     = base.labelSmall.outfit(),
)
```

- [ ] **Step 4: Write the focus modifier and the small components**

`ui/components/Focus.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/**
 * The remote's focus cue, like the web's hover: a white ring and a slight lift.
 * Put it before the clickable/focusable it describes:
 * `Modifier.tvFocus().clickable { … }`.
 */
fun Modifier.tvFocus(shape: Shape = RoundedCornerShape(10.dp)): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) 1.03f else 1f, label = "tvFocusScale")
    this
        .onFocusChanged { focused = it.hasFocus }
        .graphicsLayer { scaleX = scale; scaleY = scale }
        .border(2.dp, if (focused) SwColors.PrimaryLight else Color.Transparent, shape)
}
```

`ui/components/ViewerAvatar.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.stalkerweb.android.ui.theme.SwColors

/** A viewer's round avatar: their initial on their colour (the web's ViewerAvatar). */
@Composable
fun ViewerAvatar(name: String, color: String?, size: Dp, modifier: Modifier = Modifier) {
    val bg = parseHexColor(color)?.let { Color(it) } ?: SwColors.Surface3
    Box(modifier.size(size).background(bg, CircleShape), contentAlignment = Alignment.Center) {
        Text(
            text = name.trim().take(1).uppercase().ifEmpty { "?" },
            color = Color.White,
            fontWeight = FontWeight.SemiBold,
            fontSize = (size.value * 0.42f).sp,
        )
    }
}
```

`ui/components/EmptyState.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/** A quiet centred message for an empty or not-yet-available section. */
@Composable
fun EmptyState(icon: ImageVector, title: String, message: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, Modifier.size(40.dp), tint = SwColors.Muted.copy(alpha = 0.5f))
        Text(title, style = MaterialTheme.typography.titleMedium, color = SwColors.Text, textAlign = TextAlign.Center)
        if (message != null) Text(message, style = MaterialTheme.typography.bodyMedium, color = SwColors.Muted, textAlign = TextAlign.Center)
        action?.invoke()
    }
}
```

`ui/components/Pill.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/** A rounded choice chip (genres, categories, filters) — white when selected, like the web's pills. */
@Composable
fun Pill(text: String, selected: Boolean, onClick: () -> Unit, leading: ImageVector? = null, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(50)
    Row(
        modifier
            .tvFocus(shape)
            .background(if (selected) SwColors.Primary else SwColors.Surface2, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val fg = if (selected) SwColors.Bg else SwColors.Muted
        if (leading != null) Icon(leading, null, Modifier.size(14.dp), tint = fg)
        Text(text, style = MaterialTheme.typography.labelLarge, color = fg, maxLines = 1)
    }
}
```

`ui/components/SectionHeader.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/** "♥ FAVORITES 3 ⌃" — an uppercase section title with a count; collapsible when [onToggle] is given. */
@Composable
fun SectionHeader(icon: ImageVector, title: String, count: Int? = null, expanded: Boolean? = null, onToggle: (() -> Unit)? = null) {
    val mod = if (onToggle != null) Modifier.tvFocus(RoundedCornerShape(8.dp)).clickable(onClick = onToggle) else Modifier
    Row(mod.padding(vertical = 4.dp, horizontal = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(14.dp), tint = SwColors.Muted)
        Text(title.uppercase(), style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
        if (count != null && count > 0) {
            Text(
                count.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = SwColors.Muted,
                modifier = Modifier.background(SwColors.Surface2, RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
        if (expanded != null) Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(16.dp), tint = SwColors.Muted)
    }
}
```

`ui/components/RowStrip.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** A sideways-scrolling row of equal-width items (Recently watched, My List); the remote scrolls it by focus. */
@Composable
fun <T> RowStrip(items: List<T>, key: (T) -> Any, itemWidth: Dp, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    LazyRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 6.dp, horizontal = 4.dp),   // room for the focus lift
    ) {
        items(items, key = key) { item -> Box(Modifier.width(itemWidth)) { content(item) } }
    }
}
```

- [ ] **Step 5: Write `ChannelTile` and `PosterTile`**

`ui/components/ChannelTile.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * A channel the way the web shows it (components/ChannelCard.jsx): one fixed
 * shape everywhere — logo, "Ch N", a two-line name and a guide strip that's
 * there even without guide data, so a row of tiles lines up. The heart and
 * edit buttons show on focus (the remote's hover), once favourited, and
 * always on touch.
 */
@Composable
fun ChannelTile(
    channel: Channel,
    logoUrl: String?,
    isFavorite: Boolean,
    nowNext: NowNextEntry?,
    errors: Int,
    onClick: () -> Unit,
    onToggleFavorite: (() -> Unit)?,
    onEdit: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val isTv = rememberIsTV()
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .onFocusChanged { focused = it.hasFocus }
            .tvFocus(shape)
            .clip(shape)
            .background(if (focused) SwColors.Surface2 else SwColors.Surface)
            .border(1.dp, SwColors.Border, shape)
            .clickable(onClick = onClick),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp, top = 36.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)).background(SwColors.Surface2), contentAlignment = Alignment.Center) {
                if (!logoUrl.isNullOrBlank()) {
                    AsyncImage(model = logoUrl, contentDescription = channel.name, contentScale = ContentScale.Fit, modifier = Modifier.padding(4.dp))
                } else {
                    Icon(Icons.Default.Tv, null, Modifier.size(28.dp), tint = SwColors.Muted)
                }
            }
            Text(if (channel.number > 0) "Ch ${channel.number}" else "", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
            Text(
                channel.name,
                style = MaterialTheme.typography.titleSmall,
                color = SwColors.Text,
                textAlign = TextAlign.Center,
                minLines = 2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // The guide strip — always this tall.
            Column(Modifier.fillMaxWidth().height(52.dp)) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(SwColors.Border))
                Spacer(Modifier.height(6.dp))
                val now = nowNext?.now
                if (now != null) {
                    Text(now.title, style = MaterialTheme.typography.labelSmall, color = SwColors.PrimaryLight, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val nowSec = System.currentTimeMillis() / 1000
                    val span = (now.endTime - now.startTime).coerceAtLeast(1)
                    LinearProgressIndicator(
                        progress = { ((nowSec - now.startTime).toFloat() / span).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).height(3.dp),
                        color = SwColors.Primary,
                        trackColor = SwColors.Surface3,
                    )
                    nowNext.next?.let { Text("Next: ${it.title}", style = MaterialTheme.typography.labelSmall, color = SwColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
        if (errors > 0) {
            Icon(Icons.Default.Warning, "Recent stream failures", Modifier.align(Alignment.TopStart).padding(8.dp).size(16.dp), tint = SwColors.Warning)
        }
        Row(Modifier.align(Alignment.TopEnd).padding(2.dp)) {
            if (onToggleFavorite != null && (focused || isFavorite || !isTv)) {
                IconButton(onClick = onToggleFavorite, modifier = Modifier.size(36.dp)) {
                    Icon(
                        if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                        if (isFavorite) "Remove ${channel.name} from favorites" else "Add ${channel.name} to favorites",
                        Modifier.size(18.dp),
                        tint = if (isFavorite) SwColors.Heart else SwColors.Muted,
                    )
                }
            }
            if (onEdit != null) {
                IconButton(onClick = onEdit, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.Edit, "Edit ${channel.name}", Modifier.size(18.dp), tint = SwColors.Muted)
                }
            }
        }
    }
}
```

`ui/components/PosterTile.kt`:
```kotlin
package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * A movie or show the way the web shows it: a 2:3 poster (fitted, not cropped),
 * an HD badge at the bottom right, the title and year below. The bookmark and
 * download corner buttons appear when their callbacks are given — on focus,
 * once bookmarked, and always on touch.
 */
@Composable
fun PosterTile(
    title: String,
    year: String,
    posterUrl: String?,
    isHD: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    bookmarked: Boolean? = null,
    onBookmark: (() -> Unit)? = null,
    onDownload: (() -> Unit)? = null,
) {
    val isTv = rememberIsTV()
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(8.dp)
    Column(modifier.onFocusChanged { focused = it.hasFocus }.tvFocus(shape).clickable(onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(shape).background(SwColors.Surface2)) {
            if (!posterUrl.isNullOrBlank()) {
                AsyncImage(model = posterUrl, contentDescription = title, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            } else {
                Icon(Icons.Default.Movie, null, Modifier.align(Alignment.Center).size(28.dp), tint = SwColors.Muted.copy(alpha = 0.4f))
            }
            if (isHD) {
                Text(
                    "HD",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
            val showButtons = focused || !isTv
            if (onBookmark != null && (showButtons || bookmarked == true)) {
                IconButton(onClick = onBookmark, modifier = Modifier.align(Alignment.TopStart).padding(4.dp).size(36.dp).background(Color.Black.copy(alpha = 0.6f), CircleShape)) {
                    Icon(if (bookmarked == true) Icons.Default.Bookmark else Icons.Default.BookmarkBorder, if (bookmarked == true) "Remove from My List" else "Add to My List", Modifier.size(18.dp), tint = Color.White)
                }
            }
            if (onDownload != null && showButtons) {
                IconButton(onClick = onDownload, modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(36.dp).background(Color.Black.copy(alpha = 0.6f), CircleShape)) {
                    Icon(Icons.Default.Download, "Download to server", Modifier.size(18.dp), tint = Color.White)
                }
            }
        }
        Text(title, style = MaterialTheme.typography.bodySmall, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        if (year.isNotBlank()) Text(year, style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
    }
}
```

- [ ] **Step 6: Adopt them where they map directly, and drop the old backdrop**

- **`ui/vod/VodScreen.kt`**
  - Replace the body of `private fun VodCard(item: VodItem, onClick: () -> Unit)` with:
    ```kotlin
        PosterTile(title = item.name, year = item.year, posterUrl = item.screenshotUrl, isHD = item.isHD, onClick = onClick)
    ```
  - Add `import com.stalkerweb.android.ui.components.PosterTile`.
  - Remove any imports that are now unused.
- **`MainActivity.kt`**
  - Replace `.background(appBackgroundBrush())` with `.background(MaterialTheme.colorScheme.background)`.
  - Remove the `appBackgroundBrush` import, and add `androidx.compose.material3.MaterialTheme` if it isn't imported.

The channel list keeps its rows here. Sub-project 3 replaces them with `ChannelTile` grids.

- [ ] **Step 7: Commit, push and check CI**

```bash
git add -A android
git commit -m "feat(android): the web's Midnight Cinema theme, Outfit font and shared tiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks <PR> --watch
```
Expected: `build-apk` passes. If `ExperimentalTextApi` is reported as unknown or unneeded, delete the `@OptIn` line and its import, then push again.

---

### Task 6: "Who's watching?" screen

**Files:**
- Create: `ui/viewers/ViewerPickerScreen.kt`

**Interfaces:**
- Consumes:
  - `ViewerRepository.list()`, `choose(id)`, `create(name)` (Task 4)
  - `toApiError()` (Task 3)
  - `ViewerAvatar`, `tvFocus`, `EmptyState` (Task 5)
- Produces: `@Composable fun ViewerPickerScreen(viewers: ViewerRepository, required: Boolean, onChosen: () -> Unit, onClose: () -> Unit, onExitApp: () -> Unit)`

- [ ] **Step 1: Write the screen**

```kotlin
package com.stalkerweb.android.ui.viewers

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.ViewerAvatar
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import kotlinx.coroutines.launch

/**
 * "Who's watching?" (the web's ViewerPicker). [required]: startup, a deleted
 * viewer or a new server — there's no close, and Back leaves the app rather
 * than skipping the choice.
 */
@Composable
fun ViewerPickerScreen(
    viewers: ViewerRepository,
    required: Boolean,
    onChosen: () -> Unit,
    onClose: () -> Unit,
    onExitApp: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<ViewerSummary>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var nameError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val firstFocus = remember { FocusRequester() }

    fun load() {
        loadError = null
        scope.launch {
            runCatching { viewers.list() }
                .onSuccess { list = it }
                .onFailure { loadError = it.toApiError().message }
        }
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(list) { if (!list.isNullOrEmpty()) runCatching { firstFocus.requestFocus() } }
    BackHandler { if (required) onExitApp() else onClose() }

    fun pick(id: String) {
        if (busy) return
        busy = true
        scope.launch { runCatching { viewers.choose(id) }; busy = false; onChosen() }
    }

    fun add() {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || busy) return
        busy = true
        nameError = null
        scope.launch {
            runCatching { viewers.create(trimmed) }
                .onSuccess { busy = false; onChosen() }
                .onFailure { busy = false; nameError = it.toApiError().message }
        }
    }

    Box(Modifier.fillMaxSize().background(SwColors.Bg)) {
        if (!required) {
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)) {
                Icon(Icons.Default.Close, "Close", tint = SwColors.Muted)
            }
        }
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 720.dp).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Text("Who's watching?", style = MaterialTheme.typography.headlineMedium, color = SwColors.Text)
            when {
                loadError != null -> EmptyState(Icons.Default.ErrorOutline, "Couldn't load viewers", loadError) {
                    OutlinedButton(onClick = ::load) { Text("Retry") }
                }
                list == null -> CircularProgressIndicator(color = SwColors.Primary)
                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(132.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    items(list.orEmpty(), key = { it.id }) { v ->
                        val first = v.id == list?.firstOrNull()?.id
                        Column(
                            Modifier
                                .then(if (first) Modifier.focusRequester(firstFocus) else Modifier)
                                .tvFocus(RoundedCornerShape(12.dp))
                                .clickable { pick(v.id) }
                                .padding(12.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            ViewerAvatar(v.name, v.color, 88.dp)
                            Text(v.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                        }
                    }
                    item(key = "add") {
                        Column(
                            Modifier.tvFocus(RoundedCornerShape(12.dp)).clickable { adding = true }.padding(12.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Box(Modifier.size(88.dp).border(2.dp, SwColors.Border, CircleShape), contentAlignment = Alignment.Center) {
                                Icon(Icons.Default.Add, null, Modifier.size(32.dp), tint = SwColors.Muted)
                            }
                            Text("Add viewer", color = SwColors.Muted)
                        }
                    }
                }
            }
            if (adding) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it; nameError = null },
                        label = { Text("Name") },
                        singleLine = true,
                        isError = nameError != null,
                        supportingText = nameError?.let { { Text(it) } },
                    )
                    Button(onClick = ::add, enabled = name.isNotBlank() && !busy) { Text("Add") }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Commit, push and check CI**

```bash
git add -A android
git commit -m "feat(android): Who's watching? screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks <PR> --watch
```
Expected: `build-apk` passes. The screen isn't reachable yet; Task 7 adds the route.

---

### Task 7: App shell, routes, startup, events and the Settings links

**Files:**
- Create: `ui/shell/ShellViewModel.kt`, `ui/shell/AppShell.kt`, `ui/settings/SettingsScreen.kt`
- Modify: `MainActivity.kt` (routes, startup, events), `AppNavigation.kt` (routes), `ui/channels/ChannelScreen.kt` (drop the nav actions), `ui/vod/VodScreen.kt` (optional back), `ui/setup/SetupScreen.kt` (server messages, start message)

**Interfaces:**
- Consumes:
  - Tasks 1–6
  - `connectionLabel`, `navLayoutFor`
  - `AppEvents.events`
  - `ViewerRepository.startupChoice()`, `forget()`, `current`
  - `ServerRepository.getSettings()`, `testConnection()`, `getProfiles()`
- Produces:
  - `class ShellViewModel(server, viewers)`, with `state: StateFlow<ShellState>` (fields `connection`, `unreachable`, `vodEnabled`, `epgEnabled`) and `refreshStatus()`, `loadSettings()`
  - `@Composable AppShell(...)`
  - Routes:
    - `Screen.Shell` (`"shell"`)
    - `Screen.Viewers` (`"viewers?required={required}"`, `go(required)`)
    - `Screen.Setup` (`"setup?message={message}"`, `go(message)`)

- [ ] **Step 1: Write `ShellViewModel.kt`**

```kotlin
package com.stalkerweb.android.ui.shell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.ApiError
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.ConnectionLabel
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.data.repo.connectionLabel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ShellState(
    val connection: ConnectionLabel? = null,
    val unreachable: Boolean = false,
    val vodEnabled: Boolean = true,
    val epgEnabled: Boolean = true,
)

/** The shell's status: which connection is in use, whether the server answers, which sections are on. */
class ShellViewModel(private val server: ServerRepository, val viewers: ViewerRepository) : ViewModel() {
    private val _state = MutableStateFlow(ShellState())
    val state: StateFlow<ShellState> = _state.asStateFlow()

    init {
        loadSettings()
        viewModelScope.launch { if (viewers.current.value == null) viewers.refresh() }
    }

    fun loadSettings() {
        viewModelScope.launch {
            server.getSettings()?.let { _state.value = _state.value.copy(vodEnabled = it.vodEnabled, epgEnabled = it.epgEnabled) }
        }
    }

    /** One status check (the shell runs it every 30 s while the app is in front). */
    suspend fun refreshStatus() {
        runCatching { server.testConnection() }
            .onSuccess { status ->
                val profiles = server.getProfiles().profiles
                _state.value = _state.value.copy(connection = connectionLabel(status, profiles), unreachable = false)
            }
            .onFailure { e ->
                _state.value = _state.value.copy(unreachable = e.toApiError() is ApiError.Unreachable)
            }
    }
}
```

- [ ] **Step 2: Write `SettingsScreen.kt`** (until sub-project 4)

```kotlin
package com.stalkerweb.android.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Router
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors

/** Settings until the web's tabs arrive (sub-project 4): the server and the IPTV connection. */
@Composable
fun SettingsScreen(onOpenServer: () -> Unit, onOpenConnection: () -> Unit) {
    Column(Modifier.padding(24.dp).widthIn(max = 640.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall, color = SwColors.Text)
        SettingsLink(Icons.Default.Dns, "Server and access key", "The StalkerWeb server this app talks to", onOpenServer)
        SettingsLink(Icons.Default.Router, "IPTV connection", "Connect, switch or disconnect your provider", onOpenConnection)
        Text("More settings are on the web app for now.", style = MaterialTheme.typography.bodySmall, color = SwColors.Muted)
    }
}

@Composable
private fun SettingsLink(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Surface(color = SwColors.Surface, shape = shape, modifier = Modifier.fillMaxWidth().tvFocus(shape).clickable(onClick = onClick)) {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = SwColors.Muted)
            Column {
                Text(title, style = MaterialTheme.typography.titleSmall, color = SwColors.Text)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = SwColors.Muted)
            }
        }
    }
}
```

- [ ] **Step 3: Write `AppShell.kt`**

```kotlin
package com.stalkerweb.android.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.ViewList
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.ViewerAvatar
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private data class Section(val route: String, val label: String, val icon: ImageVector)

private val CHANNELS  = Section("channels", "Channels", Icons.Default.Tv)
private val VOD       = Section("vod", "VOD", Icons.Default.Movie)
private val DOWNLOADS = Section("downloads", "Downloads", Icons.Default.Download)
private val GUIDE     = Section("guide", "Guide", Icons.Default.GridView)
private const val SETTINGS = "settings"
private const val STATUS_POLL_MS = 30_000L

/**
 * The app's frame, like the web's sidebar: Channels, VOD, Downloads, Guide,
 * with the viewer, the connection and Settings. A side rail on TVs and wide
 * screens (the remote moves into it with Left), a bottom bar on phones.
 */
@Composable
fun AppShell(
    vm: ShellViewModel,
    channels: @Composable () -> Unit,
    vod: @Composable () -> Unit,
    onSwitchViewer: () -> Unit,
    onOpenServer: () -> Unit,
    onOpenConnection: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val viewer by vm.viewers.current.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val current = nav.currentBackStackEntryAsState().value?.destination?.route
    val scope = rememberCoroutineScope()
    val layout = navLayoutFor(LocalConfiguration.current.screenWidthDp, rememberIsTV())

    // Status every 30 s while the app is in front (as the web does).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { vm.refreshStatus(); delay(STATUS_POLL_MS) }
        }
    }

    val sections = buildList {
        add(CHANNELS)
        if (state.vodEnabled) add(VOD)
        add(DOWNLOADS)
        if (state.epgEnabled) add(GUIDE)
    }
    fun go(route: String) = nav.navigate(route) {
        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }

    val content: @Composable () -> Unit = {
        Column(Modifier.fillMaxSize()) {
            if (state.unreachable) {
                Row(
                    Modifier.fillMaxWidth().background(SwColors.Surface2).padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Default.CloudOff, null, tint = SwColors.Warning, modifier = Modifier.size(18.dp))
                    Text("Can't reach the server", color = SwColors.Text, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { vm.refreshStatus() } }) { Text("Retry") }
                }
            }
            NavHost(nav, startDestination = CHANNELS.route, modifier = Modifier.weight(1f)) {
                composable(CHANNELS.route) { channels() }
                composable(VOD.route) { vod() }
                composable(DOWNLOADS.route) { EmptyState(Icons.Default.Download, "Downloads are coming soon", "For now they're on the web app.") }
                composable(GUIDE.route) { EmptyState(Icons.Default.ViewList, "The guide is coming soon", "For now it's on the web app.") }
                composable(SETTINGS) {
                    com.stalkerweb.android.ui.settings.SettingsScreen(onOpenServer = onOpenServer, onOpenConnection = onOpenConnection)
                }
            }
        }
    }

    if (layout == NavLayout.RAIL) {
        Row(Modifier.fillMaxSize()) {
            NavigationRail(containerColor = SwColors.Bg, modifier = Modifier.width(88.dp)) {
                sections.forEach { s ->
                    NavigationRailItem(
                        selected = current == s.route,
                        onClick = { go(s.route) },
                        icon = { Icon(s.icon, null) },
                        label = { Text(s.label) },
                    )
                }
                Spacer(Modifier.weight(1f))
                viewer?.let { v ->
                    Box(Modifier.tvFocus(RoundedCornerShape(50)).clickable(onClick = onSwitchViewer).padding(8.dp)) {
                        ViewerAvatar(v.name, v.color, 32.dp)
                    }
                }
                state.connection?.let { c ->
                    Text(
                        c.name,
                        style = MaterialTheme.typography.labelSmall,
                        color = SwColors.Muted,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.tvFocus().clickable(onClick = onOpenConnection).padding(6.dp),
                    )
                }
                NavigationRailItem(
                    selected = current == SETTINGS,
                    onClick = { go(SETTINGS) },
                    icon = { Icon(Icons.Default.Settings, null) },
                    label = { Text("Settings") },
                )
                Spacer(Modifier.height(8.dp))
            }
            Box(Modifier.weight(1f)) { content() }
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            // Phone top row: the connection on the left, the viewer's menu on the right.
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(state.connection?.name ?: "", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                var menu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { menu = true }) { ViewerAvatar(viewer?.name ?: "?", viewer?.color, 28.dp) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Switch viewer") }, onClick = { menu = false; onSwitchViewer() })
                        DropdownMenuItem(
                            text = { Text(state.connection?.let { "Connection: ${it.name}" } ?: "IPTV connection") },
                            onClick = { menu = false; onOpenConnection() },
                        )
                        DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; go(SETTINGS) })
                    }
                }
            }
            Box(Modifier.weight(1f)) { content() }
            NavigationBar(containerColor = SwColors.Bg) {
                sections.forEach { s ->
                    NavigationBarItem(
                        selected = current == s.route,
                        onClick = { go(s.route) },
                        icon = { Icon(s.icon, null) },
                        label = { Text(s.label) },
                    )
                }
            }
        }
    }
}
```

- [ ] **Step 4: Update the routes in `AppNavigation.kt`**

Inside `sealed class Screen`:
- Replace `object Setup : Screen("setup")` with:
```kotlin
    object Setup : Screen("setup?message={message}") {
        fun go(message: String? = null): String = "setup?message=${Uri.encode(message ?: "")}"
    }
    object Viewers : Screen("viewers?required={required}") {
        fun go(required: Boolean): String = "viewers?required=$required"
    }
    object Shell : Screen("shell")
```
- Remove `object Channels` and `object Vod`. They now live inside the shell.

- [ ] **Step 5: Trim the section screens for the shell, and pass server messages through in Setup**

- **`ChannelScreen.kt`**
  - Remove the parameters `vodEnabled`, `onOpenVod`, `onOpenSettings` and `onOpenPortal`.
  - In the `TopAppBar` `actions`, delete the `if (vodEnabled) { … }` block and the `onOpenPortal` and `onOpenSettings` `IconButton`s. Keep the Refresh button.
  - Change the title text from `"stalkerweb"` to `"Channels"`.
- **`VodScreen.kt`**
  - Change `onBack: () -> Unit` to `onBack: (() -> Unit)? = null`.
  - In the `TopAppBar`, replace the `navigationIcon = { IconButton(onClick = onBack) { … } }` argument with:
    ```kotlin
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                            }
                        }
                    },
    ```
  - Change the title text from `"On Demand"` to `"VOD"`.
- **`SetupScreen.kt`**
  - Add the parameter `startMessage: String? = null`.
  - Initialise `var error by remember { mutableStateOf<String?>(startMessage?.takeIf { it.isNotBlank() }) }`.
  - Replace the `connectError` function with:
    ```kotlin
    // The server's own words where it gave them — "Wrong access key — 2 tries
    // left…", "try again in 30 minutes" — and a plain hint when nothing answered.
    private fun connectError(e: Throwable): String = when (val err = e.toApiError()) {
        is ApiError.Unreachable -> "Can't reach the server — check the address and port."
        else -> err.message ?: "Couldn't connect."
    }
    ```
  - Add the imports `com.stalkerweb.android.data.api.ApiError` and `com.stalkerweb.android.data.api.toApiError`, and remove the `retrofit2.HttpException` import if it's now unused.

- [ ] **Step 6: Wire `MainActivity` — container, startup, events and routes**

In `MainActivity.onCreate`, inside `setContent { StalkerTheme { … } }`:
- **Start destination:**
  ```kotlin
  val startDest = if (container.server.getServerUrl() != null) Screen.Shell.route else Screen.Setup.route
  ```
- **Overscan:** the padding should be `24.dp` on TV except on the player routes:
  ```kotlin
  val overscanPadding = if (isTV && currentRoute != Screen.Player.route && currentRoute != Screen.VodPlayer.route) 24.dp else 0.dp
  ```
- **Navigation helpers:**
  ```kotlin
  fun toShell() = navController.navigate(Screen.Shell.route) { popUpTo(0) { inclusive = true } }
  fun toPicker(required: Boolean) = navController.navigate(Screen.Viewers.go(required)) {
      if (required) popUpTo(0) { inclusive = true }
  }
  ```
- **Startup:** replace the existing "A saved server URL doesn't mean the portal itself is connected" `LaunchedEffect` with:
  ```kotlin
  // Startup: who's watching first (as on the web), then whether a portal is connected.
  LaunchedEffect(Unit) {
      if (container.server.getServerUrl() == null) return@LaunchedEffect
      if (container.viewers.startupChoice().needsPicker) { toPicker(required = true); return@LaunchedEffect }
      val status = runCatching { container.server.testConnection() }.getOrNull()
      if (status?.connected == false) navController.navigate(Screen.Portal.route)
  }
  ```
- **App-wide events:**
  ```kotlin
  // Problems any request can hit: a deleted viewer, or the access key no longer accepted.
  LaunchedEffect(Unit) {
      container.events.events.collect { event ->
          val route = navController.currentBackStackEntry?.destination?.route
          when (event) {
              is AppEvent.ViewerGone -> if (route != Screen.Viewers.route) {
                  container.viewers.forget()
                  toPicker(required = true)
              }
              is AppEvent.AccessProblem -> if (route != Screen.Setup.route) {
                  // Leave the shell at once: every request carries the key, and each
                  // wrong one counts toward the server's lockout.
                  navController.navigate(Screen.Setup.go(event.message)) { popUpTo(0) { inclusive = true } }
              }
          }
      }
  }
  ```
- **Remove** the `vodEnabled` state and its `LaunchedEffect`. The shell owns that now.
- **`NavHost` destinations:**
  - Remove the old `Screen.Channels` and `Screen.Vod` `composable` blocks.
  - Replace the `Screen.Setup` block with:
    ```kotlin
    composable(
        Screen.Setup.route,
        arguments = listOf(navArgument("message") { type = NavType.StringType; defaultValue = "" }),
    ) { backStack ->
        val fromApp = navController.previousBackStackEntry != null
        SetupScreen(
            server       = container.server,
            startMessage = backStack.arguments?.getString("message"),
            onConnected  = {
                channelViewModel.load(reset = true)
                // A new server or key forgot the viewer (ServerRepository.setServerUrl): ask again.
                if (container.viewers.savedViewerId() == null) toPicker(required = true) else toShell()
            },
            onBack = if (fromApp) ({ navController.popBackStack() }) else null,
        )
    }
    ```
  - Add the picker:
    ```kotlin
    composable(
        Screen.Viewers.route,
        arguments = listOf(navArgument("required") { type = NavType.BoolType; defaultValue = false }),
    ) { backStack ->
        val required = backStack.arguments?.getBoolean("required") ?: false
        ViewerPickerScreen(
            viewers   = container.viewers,
            required  = required,
            onChosen  = { toShell() },
            onClose   = { navController.popBackStack() },
            onExitApp = { finish() },
        )
    }
    ```
  - Add the shell. Create `shellVmFactory` the same way as the other factories, with `ShellViewModel(container.server, container.viewers)`.
    ```kotlin
    composable(Screen.Shell.route) {
        val shellViewModel: ShellViewModel = viewModel(factory = shellVmFactory)
        AppShell(
            vm = shellViewModel,
            channels = {
                ChannelScreen(
                    viewModel = channelViewModel,
                    onSelectChannel = { channel -> navController.navigate(Screen.Player.go(channel.uniqueId, channel.name)) },
                )
            },
            vod = {
                VodScreen(
                    viewModel = vodViewModel,
                    onPlayMovie = { item -> navController.navigate(Screen.VodPlayer.go(videoId = item.id, cmd = item.cmd, title = item.name)) },
                    onPlayEpisode = { show, season, episodeId, seriesNumber, title ->
                        navController.navigate(
                            Screen.VodPlayer.go(videoId = show.id, series = seriesNumber, seasonId = season.id, episodeId = episodeId, title = "${show.name} · $title")
                        )
                    },
                )
            },
            onSwitchViewer   = { toPicker(required = false) },
            onOpenServer     = { navController.navigate(Screen.Setup.go()) },
            onOpenConnection = { navController.navigate(Screen.Portal.route) },
        )
    }
    ```
- **Portal:** in the `Screen.Portal` block's `onBack`, keep `channelViewModel.load()` and `navController.popBackStack()`. When the back stack is empty (Portal was opened at startup), call `toShell()` instead of `popBackStack()`:
  ```kotlin
  if (!navController.popBackStack()) toShell()
  ```
- **Imports to add:**
  - `com.stalkerweb.android.data.api.AppEvent`
  - `com.stalkerweb.android.ui.shell.AppShell`
  - `com.stalkerweb.android.ui.shell.ShellViewModel`
  - `com.stalkerweb.android.ui.viewers.ViewerPickerScreen`
  - `androidx.navigation.NavType`, if it isn't already imported

  Then remove any imports that are now unused.

- [ ] **Step 7: Commit, push and check CI**

```bash
git add -A android
git commit -m "feat(android): app shell with web-like sections, Who's watching? on start, connection name, access and viewer events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh pr checks <PR> --watch
```
Expected: all four checks pass. On a compile error, read the failed log, fix the named lines, and push again.

---

### Task 8: Hand-check on a device, then mark the PR ready

**Files:** none; this task is verification.

- [ ] **Step 1: Install the CI debug APKs.** Download the `app-mobile-debug.apk` and `app-tv-debug.apk` artifacts from the PR's `build-apk` run:
  ```bash
  gh run download <run> -n <artifact-name>
  ```
  Install them on a phone and on a TV box with `adb install -r`.

- [ ] **Step 2: Walk through the checklist on both devices** and note anything that fails:
  - [ ] **First launch after the update:** "Who's watching?" appears, even with one viewer. Back exits the app.
  - [ ] **Add viewer:**
    - [ ] An empty or duplicate name shows the server's message under the field.
    - [ ] A valid name opens the shell as that viewer.
  - [ ] **Channels:**
    - [ ] Each viewer's hidden genres and languages are hidden.
    - [ ] Adult channels are hidden unless that viewer shows them.
  - [ ] **Switching viewers:**
    - [ ] Opening the avatar (TV: in the rail via the D-pad; phone: top right) and picking another viewer reloads Channels and VOD.
    - [ ] Favorites follow the viewer.
  - [ ] **Connection name:**
    - [ ] It shows in the rail on TV, and at the top on a phone.
    - [ ] Tapping or pressing it opens the IPTV connection screen.
  - [ ] **Unreachable server:** stopping the server shows the "Can't reach the server" banner within 30 s, and Retry clears it once the server is back.
  - [ ] **Changed access key:** after changing `ACCESS_KEY` on the server, the app returns to Setup with "Access key required." Entering a wrong key shows "N tries left".
  - [ ] **Deleted viewer:** deleting this viewer on the web makes the app ask "Who's watching?" on its next request.
  - [ ] **Theme:** the background is near-black, the accents white, the text is in Outfit, and focused items show a white ring.
  - [ ] **Settings:** "Server and access key" opens Setup, and "IPTV connection" opens the Portal screen.

- [ ] **Step 3: Mark the PR ready.** Do this once the checklist passes, or after you've fixed what it found and re-checked.
  ```bash
  gh pr ready <PR>
  ```
  Update the PR body with what changed and the checklist results. **Don't merge or release yet:** sub-projects 2–4 come next, and the release waits for all four.
