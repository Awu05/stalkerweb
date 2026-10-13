# Android Parity Part 3: Live TV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Android Channels screen the web's features:
- search, the channel count, "Hide flaky", and collapsible genre pills
- a collapsible Favorites section with groups
- a Recently Watched row
- a `ChannelTile` grid with now/next and health
- number jump
- a long-press menu for tile actions
- the edit logo dialog

The player also gets a toast confirming favorite changes.

**Architecture:**
- **Pure rules** in `data/repo/LiveRules.kt`, unit-tested: filtering, flaky count, number jump and reordering.
- **`LiveRepository`** gains the favorites, groups, health and logo endpoints.
- **`ChannelViewModel` and `ChannelScreen`** are rewritten.
- **Dialogs** go in `ui/channels/ChannelDialogs.kt`.
- **`ChannelTile`'s corner buttons** become touch-only (not focusable), and long-press opens the action menu.

**Tech Stack:** Kotlin 2.4, Compose (Material 3), Retrofit and Moshi, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-12-android-parity-3-live-design.md`

## Global Constraints

- **Branch** `feat/android-live`, stacked on `feat/android-vod`; the PR goes into main. CI compiles and tests on each push, as in parts 1–2.
- **Constants:** `FLAKY_THRESHOLD = 2`; the genre row collapses above 12 pills; number jump takes up to 4 digits with a 1.2 s wait; now/next refreshes every 5 min and health every 60 s.
- **Grid columns:** `GridCells.Adaptive(150.dp)`, or `180.dp` on TV.
- **Favorites open** is per device: `AppPrefs.favoritesOpen`, default true.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The remote reaches every tile action.** The corner buttons aren't focusable, and long-press (a held OK) opens the menu. Checked by hand.
2. **Typing digits in the search field doesn't trigger number jump.** Checked by hand.
3. **Moving a favorite at either end, or with a stale index, never crashes.** Pinned by the `moveItem` tests.
4. **A failed favorites or groups call shows a message and reloads, rather than leaving the list wrong.** Checked by hand.
5. **Switching viewer reloads favorites, groups and the channel list.** The existing `viewers.changes` reload is kept. Checked by hand.

---

### Task 1: `LiveRules` and its tests

**Files:**
- Create: `data/repo/LiveRules.kt`
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/LiveRulesTest.kt`
- Modify: `data/api/Models.kt`, adding `ChannelHealth`

**Interfaces:**
- Produces:
  - `const val FLAKY_THRESHOLD = 2`
  - `filterChannels(channels: List<Channel>, groupId: String?, query: String, hideFlaky: Boolean, health: Map<String, ChannelHealth>): List<Channel>`
  - `flakyCount(channels, health): Int`
  - `jumpTarget(channels, digits: String): Channel?`
  - `fun <T> moveItem(list: List<T>, index: Int, delta: Int): List<T>`

- [ ] **Step 1: Add the model.** At the end of `Models.kt`, add:
```kotlin
/** A channel's recent stream failures (backend /api/channels/health). */
@JsonClass(generateAdapter = false)
data class ChannelHealth(
    val errors: Int = 0,
    val lastError: String? = null,
)
```

- [ ] **Step 2: Write the failing test**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveRulesTest {
    private fun ch(id: String, number: Int, name: String, genreId: String) = Channel(uniqueId = id, number = number, name = name, genreId = genreId)
    private val channels = listOf(
        ch("a", 1, "BBC One", "news"), ch("b", 2, "CNN", "news"), ch("c", 10, "ESPN", "sports"), ch("d", 101, "Sky Sports", "sports"),
    )
    private val health = mapOf("b" to ChannelHealth(errors = 3), "c" to ChannelHealth(errors = 1))
    private fun ids(list: List<Channel>) = list.map { it.uniqueId }

    @Test fun filtersByGenreSearchAndFlakyTogether() {
        assertEquals(listOf("a", "b", "c", "d"), ids(filterChannels(channels, null, "", false, health)))
        assertEquals(listOf("c", "d"), ids(filterChannels(channels, "sports", "", false, health)))
        assertEquals(listOf("d"), ids(filterChannels(channels, "sports", "  sky ", false, health)))
        assertEquals(listOf("a", "c", "d"), ids(filterChannels(channels, null, "", true, health)))
        assertEquals(listOf("a"), ids(filterChannels(channels, "news", "", true, health)))
    }

    @Test fun searchIsByNameIgnoringCase() {
        assertEquals(listOf("d"), ids(filterChannels(channels, null, "SKY", false, health)))
        assertEquals(listOf("c", "d"), ids(filterChannels(channels, null, "s", false, health)))
    }

    @Test fun countsFlakyChannels() {
        assertEquals(1, flakyCount(channels, health))
        assertEquals(0, flakyCount(channels, emptyMap()))
    }

    @Test fun jumpsToTheChannelNumber() {
        assertEquals("c", jumpTarget(channels, "10")?.uniqueId)
        assertEquals("c", jumpTarget(channels, "010")?.uniqueId)
        assertNull(jumpTarget(channels, "99"))
        assertNull(jumpTarget(channels, ""))
    }

    @Test fun movesAnItemWithinBounds() {
        val l = listOf("a", "b", "c")
        assertEquals(listOf("b", "a", "c"), moveItem(l, 1, -1))
        assertEquals(listOf("a", "c", "b"), moveItem(l, 1, 1))
        assertEquals(l, moveItem(l, 0, -1))
        assertEquals(l, moveItem(l, 2, 1))
        assertEquals(l, moveItem(l, 7, 1))
    }
}
```

- [ ] **Step 3: Push and confirm RED**: CI fails with unresolved `filterChannels` and the other rules.

- [ ] **Step 4: Write `LiveRules.kt`**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth

/** Channels with at least this many recent (unresolved) stream errors are "flaky" (as on the web). */
const val FLAKY_THRESHOLD = 2

private fun isFlaky(c: Channel, health: Map<String, ChannelHealth>) = (health[c.uniqueId]?.errors ?: 0) >= FLAKY_THRESHOLD

/** The channels shown: the genre ([groupId], null = All), then the name search, then without flaky ones if asked. */
fun filterChannels(channels: List<Channel>, groupId: String?, query: String, hideFlaky: Boolean, health: Map<String, ChannelHealth>): List<Channel> {
    val q = query.trim().lowercase()
    return channels.filter { c ->
        (groupId == null || c.genreId == groupId) &&
            (q.isEmpty() || c.name.lowercase().contains(q)) &&
            (!hideFlaky || !isFlaky(c, health))
    }
}

fun flakyCount(channels: List<Channel>, health: Map<String, ChannelHealth>): Int = channels.count { isFlaky(it, health) }

/** The channel whose number was typed on the remote, or null. */
fun jumpTarget(channels: List<Channel>, digits: String): Channel? {
    val n = digits.toIntOrNull() ?: return null
    return channels.firstOrNull { it.number == n }
}

/** [list] with the item at [index] moved by [delta] places; unchanged at either end or for a stale index. */
fun <T> moveItem(list: List<T>, index: Int, delta: Int): List<T> {
    val to = index + delta
    if (index !in list.indices || to !in list.indices) return list
    return list.toMutableList().apply { add(to, removeAt(index)) }
}
```

- [ ] **Step 5: Push and confirm GREEN.** Expected: 60 tests, all PASSED.

### Task 2: API and repository additions

**Files:** Modify `data/api/StalkerApi.kt`, `data/api/Models.kt`, `data/repo/LiveRepository.kt`, `data/prefs/AppPrefs.kt`.

- [ ] **Step 1: Models** (append to `Models.kt`):
```kotlin
@JsonClass(generateAdapter = false)
data class NameRequest(val name: String)

@JsonClass(generateAdapter = false)
data class OrderRequest(val order: List<String>)

@JsonClass(generateAdapter = false)
data class LogoOverrideRequest(val name: String, val url: String)

/** The logo the server finds for a name (backend routes/logos.js /check). */
@JsonClass(generateAdapter = false)
data class LogoCheck(val logo: String? = null, val name: String? = null)
```

- [ ] **Step 2: Endpoints.** In `StalkerApi`, after `removeFavorite`, add:
```kotlin
    @POST("api/favorites/groups")
    suspend fun createFavoriteGroup(@Body body: NameRequest)

    @PUT("api/favorites/groups/{id}")
    suspend fun renameFavoriteGroup(@Path("id") id: String, @Body body: NameRequest)

    @DELETE("api/favorites/groups/{id}")
    suspend fun deleteFavoriteGroup(@Path("id") id: String)

    @POST("api/favorites/groups/{id}/channels")
    suspend fun addToFavoriteGroup(@Path("id") id: String, @Body body: AddFavoriteRequest)

    @DELETE("api/favorites/groups/{id}/channels/{chId}")
    suspend fun removeFromFavoriteGroup(@Path("id") id: String, @Path("chId") chId: String)

    @PUT("api/favorites/channels/order")
    suspend fun reorderFavorites(@Body body: OrderRequest)

    @PUT("api/favorites/groups/order")
    suspend fun reorderFavoriteGroups(@Body body: OrderRequest)

    @GET("api/channels/health")
    suspend fun getChannelHealth(): Map<String, ChannelHealth>

    @GET("api/logos/check")
    suspend fun checkLogo(@Query("name") name: String): LogoCheck

    @POST("api/logos")
    suspend fun setLogoOverride(@Body body: LogoOverrideRequest)
```

- [ ] **Step 3: `LiveRepository`.** After `removeFavorite`, add:
```kotlin
    /** The viewer's favorites: channels in their order, and groups (each with its channels). */
    suspend fun getFavorites(): FavoritesResponse = apis.get().getFavorites()

    suspend fun createGroup(name: String) = apis.get().createFavoriteGroup(NameRequest(name.trim()))
    suspend fun renameGroup(id: String, name: String) = apis.get().renameFavoriteGroup(id, NameRequest(name.trim()))
    suspend fun deleteGroup(id: String) = apis.get().deleteFavoriteGroup(id)
    suspend fun addToGroup(groupId: String, uniqueId: String) = apis.get().addToFavoriteGroup(groupId, AddFavoriteRequest(uniqueId))
    suspend fun removeFromGroup(groupId: String, uniqueId: String) = apis.get().removeFromFavoriteGroup(groupId, uniqueId)
    suspend fun reorderFavorites(order: List<String>) = apis.get().reorderFavorites(OrderRequest(order))
    suspend fun reorderGroups(order: List<String>) = apis.get().reorderFavoriteGroups(OrderRequest(order))

    /** Recent stream failures per channel; empty when unknown. */
    suspend fun getHealth(): Map<String, ChannelHealth> = runCatching { apis.get().getChannelHealth() }.getOrDefault(emptyMap())

    /** The logo the server finds for [name], made absolute for Coil; null when none. */
    suspend fun checkLogo(name: String): String? = runCatching { apis.get().checkLogo(name).logo }.getOrNull()
        ?.takeIf { it.isNotBlank() }?.let { links.absoluteImage(it) }

    suspend fun setLogoOverride(name: String, url: String) = apis.get().setLogoOverride(LogoOverrideRequest(name, url.trim()))
```
Add the imports for `FavoritesResponse`, `NameRequest`, `OrderRequest`, `ChannelHealth` and `LogoOverrideRequest`.

- [ ] **Step 4: `AppPrefs`.** After `vodSort`, add:
```kotlin
    // Whether the Channels page's Favorites section is open, remembered on this device.
    var favoritesOpen: Boolean
        get() = prefs.getBoolean(KEY_FAVORITES_OPEN, true)
        set(value) = prefs.edit().putBoolean(KEY_FAVORITES_OPEN, value).apply()
```
Then add the key: `private const val KEY_FAVORITES_OPEN = "favorites_open"`.

- [ ] **Step 5: Push and confirm GREEN** (60 tests).

### Task 3: `ChannelTile`: touch-only corner buttons, long-press

**Files:** Modify `ui/components/ChannelTile.kt`.

- [ ] **Step 1: Make the changes**
  - Add the parameter `onLongClick: (() -> Unit)? = null`, after `onEdit`.
  - Replace `.clickable(onClick = onClick)` with `.combinedClickable(onClick = onClick, onLongClick = onLongClick)`, and add `@OptIn(ExperimentalFoundationApi::class)`.
  - Give both `IconButton`s `Modifier.focusProperties { canFocus = false }`. This keeps the remote's focus on the tile; long-press is how the remote reaches these actions.
  - Show the corner buttons only on touch: `!isTv && (…)`, or `isFavorite` for the heart.
  - Update the KDoc to say so.

- [ ] **Step 2: Push and confirm GREEN.**

### Task 4: `ChannelViewModel`, `ChannelScreen` and the dialogs (rewritten)

**Files:**
- Rewrite: `ui/channels/ChannelViewModel.kt` (Appendix A) and `ui/channels/ChannelScreen.kt` (Appendix B)
- Create: `ui/channels/ChannelDialogs.kt` (Appendix C)
- Modify: `MainActivity.kt`. The channel factory becomes `ChannelViewModel(container.live, container.server, container.viewers, container.prefs)`.

- [ ] **Step 1:** Write the three files from the appendices.
- [ ] **Step 2:** Update the `MainActivity` factory.
- [ ] **Step 3:** Commit.

### Task 5: Player favorite toast

**Files:** Modify `ui/player/PlayerViewModel.kt`.

- [ ] **Step 1:** In `toggleFavorite`, add an `onSuccess` before `onFailure`:
```kotlin
            }.onSuccess {
                Toast.makeText(getApplication(), if (isFav) "Removed ${channel.name} from favorites" else "Added ${channel.name} to favorites", Toast.LENGTH_SHORT).show()
            }.onFailure {
```
Add `import android.widget.Toast`.

- [ ] **Step 2:** Commit, then push Tasks 4 and 5 together and confirm GREEN: all checks pass, 60 tests.

---

## Appendix A: `ui/channels/ChannelViewModel.kt`

```kotlin
package com.stalkerweb.android.ui.channels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth
import com.stalkerweb.android.data.api.FavoriteGroup
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.prefs.WatchedChannel
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.data.repo.filterChannels
import com.stalkerweb.android.data.repo.flakyCount
import com.stalkerweb.android.data.repo.moveItem
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import retrofit2.HttpException

data class ChannelUiState(
    val channels: List<Channel> = emptyList(),
    val logoMap: Map<String, String> = emptyMap(),
    val groups: List<Group> = emptyList(),
    val nowNext: Map<String, NowNextEntry> = emptyMap(),
    val health: Map<String, ChannelHealth> = emptyMap(),
    val favoriteIds: Set<String> = emptySet(),
    val favoriteChannels: List<Channel> = emptyList(),   // in the viewer's order
    val favoriteGroups: List<FavoriteGroup> = emptyList(),
    val recentChannels: List<WatchedChannel> = emptyList(),
    val selectedGroupId: String? = null,
    val query: String = "",
    val hideFlaky: Boolean = false,
    val favoritesOpen: Boolean = true,
    val loading: Boolean = true,
    val error: String? = null,
    // The backend answered 503 "not connected to a portal": point at the Portal screen.
    val portalNotConnected: Boolean = false,
) {
    val displayed: List<Channel> get() = filterChannels(channels, selectedGroupId, query, hideFlaky, health)
    val flaky: Int get() = flakyCount(channels, health)
    /** Favorites and Recently Watched show on All with no search (as on the web). */
    val browsing: Boolean get() = selectedGroupId == null && query.isBlank()
}

/**
 * The Channels page, as on the web (frontend/src/pages/ChannelsPage.jsx):
 * the viewer's channels (filtered for them), favorites with groups, recently
 * watched on this device, now/next and stream health.
 */
class ChannelViewModel(
    private val live: LiveRepository,
    private val server: ServerRepository,
    private val viewers: ViewerRepository,
    private val prefs: AppPrefs,
) : ViewModel() {

    private val _state = MutableStateFlow(ChannelUiState(favoritesOpen = prefs.favoritesOpen))
    val state: StateFlow<ChannelUiState> = _state.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Short messages for a toast (a save that failed). */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    init {
        if (server.getServerUrl() != null) load()
        // Another viewer: their favorites and filters — read the lists again.
        viewModelScope.launch { viewers.changes.drop(1).collect { load(reset = true) } }
    }

    /** @param reset clears what's shown first (another server or viewer). */
    fun load(reset: Boolean = false) {
        if (reset) {
            _state.value = _state.value.copy(
                channels = emptyList(), logoMap = emptyMap(), groups = emptyList(), favoriteIds = emptySet(),
                favoriteChannels = emptyList(), favoriteGroups = emptyList(), nowNext = emptyMap(), selectedGroupId = null,
            )
        }
        // The on-disk cache first (this viewer's), so the grid appears at once; the network replaces it.
        val cached = live.getCachedChannels()
        val cachedLogos = live.getCachedLogoMap()
        val haveData = cached.isNotEmpty() || _state.value.channels.isNotEmpty()
        _state.value = _state.value.copy(
            loading = !haveData, error = null, portalNotConnected = false, recentChannels = live.getWatched(),
            channels = _state.value.channels.ifEmpty { cached },
            logoMap = _state.value.logoMap.ifEmpty { cachedLogos },
        )
        viewModelScope.launch {
            runCatching {
                // coroutineScope: a failing async is rethrown here, where runCatching catches it
                // (a portal-not-connected 503 becomes the banner, not a crash).
                coroutineScope {
                    val channels = async { live.getChannels() }
                    val logos = async { live.getLogoMap() }
                    val groups = async { live.getGroups() }
                    Triple(channels.await(), logos.await(), groups.await())
                }
            }.onSuccess { (channels, logos, groups) ->
                _state.value = _state.value.copy(channels = channels, logoMap = logos, groups = groups, loading = false)
            }.onFailure { e ->
                val notConnected = e is HttpException && e.code() == 503
                _state.value = _state.value.copy(
                    loading = false, portalNotConnected = notConnected,
                    error = if (!notConnected && _state.value.channels.isEmpty()) e.toApiError().message else null,
                )
            }
        }
        loadFavorites()
        refreshNowNext()
        refreshHealth()
    }

    fun loadFavorites() {
        viewModelScope.launch {
            runCatching { live.getFavorites() }.onSuccess { f ->
                _state.value = _state.value.copy(
                    favoriteChannels = f.channels.distinctBy { it.uniqueId },
                    favoriteGroups = f.groups,
                    favoriteIds = f.channels.map { it.uniqueId }.toSet(),
                )
            }
        }
    }

    fun refreshNowNext() {
        viewModelScope.launch {
            val nowNext = live.getNowNext()
            if (nowNext.isNotEmpty()) _state.value = _state.value.copy(nowNext = nowNext)
        }
    }

    fun refreshHealth() {
        viewModelScope.launch { _state.value = _state.value.copy(health = live.getHealth()) }
    }

    /** Re-read this device's history — after returning from the player (MainActivity.onResume). */
    fun refreshHistory() { _state.value = _state.value.copy(recentChannels = live.getWatched()) }

    fun removeRecent(uniqueId: String) {
        live.removeWatched(uniqueId)
        refreshHistory()
    }

    fun setQuery(q: String) { _state.value = _state.value.copy(query = q) }
    fun setSelectedGroup(id: String?) { _state.value = _state.value.copy(selectedGroupId = id) }
    fun setHideFlaky(on: Boolean) { _state.value = _state.value.copy(hideFlaky = on) }
    fun toggleFavoritesOpen() {
        val open = !_state.value.favoritesOpen
        prefs.favoritesOpen = open
        _state.value = _state.value.copy(favoritesOpen = open)
    }

    // ── Favorites ─────────────────────────────────────────────────────────────

    fun toggleFavorite(channel: Channel) {
        val id = channel.uniqueId
        val isFav = id in _state.value.favoriteIds
        // At once: the heart, and the Favorites section.
        _state.value = _state.value.copy(
            favoriteIds = if (isFav) _state.value.favoriteIds - id else _state.value.favoriteIds + id,
            favoriteChannels = if (isFav) _state.value.favoriteChannels.filter { it.uniqueId != id }
                               else _state.value.favoriteChannels + channel,
        )
        save { if (isFav) live.removeFavorite(id) else live.addFavorite(id) }
    }

    /** A favorite moved one place left or right (the remote can't drag). */
    fun moveFavorite(channel: Channel, delta: Int) {
        val list = _state.value.favoriteChannels
        val moved = moveItem(list, list.indexOfFirst { it.uniqueId == channel.uniqueId }, delta)
        if (moved == list) return
        _state.value = _state.value.copy(favoriteChannels = moved)
        save(reload = false) { live.reorderFavorites(moved.map { it.uniqueId }) }
    }

    fun moveGroup(group: FavoriteGroup, delta: Int) {
        val list = _state.value.favoriteGroups
        val moved = moveItem(list, list.indexOfFirst { it.id == group.id }, delta)
        if (moved == list) return
        _state.value = _state.value.copy(favoriteGroups = moved)
        save(reload = false) { live.reorderGroups(moved.map { it.id }) }
    }

    fun createGroup(name: String) { if (name.isNotBlank()) save { live.createGroup(name) } }
    fun renameGroup(group: FavoriteGroup, name: String) { if (name.isNotBlank()) save { live.renameGroup(group.id, name) } }
    fun deleteGroup(group: FavoriteGroup) {
        _state.value = _state.value.copy(favoriteGroups = _state.value.favoriteGroups.filter { it.id != group.id })
        save { live.deleteGroup(group.id) }
    }
    fun addToGroup(group: FavoriteGroup, channel: Channel) = save { live.addToGroup(group.id, channel.uniqueId) }
    fun removeFromGroup(group: FavoriteGroup, channel: Channel) = save { live.removeFromGroup(group.id, channel.uniqueId) }

    // A favorites change on the server; on failure say so and read the truth back.
    private fun save(reload: Boolean = true, call: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { call() }
                .onSuccess { if (reload) loadFavorites() }
                .onFailure {
                    _messages.tryEmit("Couldn't save — try again")
                    loadFavorites()
                }
        }
    }

    // ── Logos ─────────────────────────────────────────────────────────────────

    suspend fun checkLogo(name: String): String? = live.checkLogo(name)

    fun saveLogo(channel: Channel, url: String) {
        viewModelScope.launch {
            runCatching { live.setLogoOverride(channel.name, url) }
                .onSuccess { _state.value = _state.value.copy(logoMap = live.getLogoMap()) }
                .onFailure { _messages.tryEmit("Couldn't save the logo") }
        }
    }
}
```

`LiveRepository` needs `removeWatched(uniqueId)`, and `AppPrefs` needs `removeWatchedChannel`:
```kotlin
    // AppPrefs
    fun removeWatchedChannel(uniqueId: String) {
        val list = getWatchedChannels().filter { it.uniqueId != uniqueId }
        prefs.edit().putString(KEY_WATCH_HISTORY, historyToJson(list)).apply()
    }
    // LiveRepository
    fun removeWatched(uniqueId: String) = prefs.removeWatchedChannel(uniqueId)
```

## Appendix B: `ui/channels/ChannelScreen.kt`

```kotlin
package com.stalkerweb.android.ui.channels

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Router
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.FavoriteGroup
import com.stalkerweb.android.data.repo.jumpTarget
import com.stalkerweb.android.ui.components.ChannelTile
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.SectionHeader
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val GENRE_COLLAPSE_THRESHOLD = 12

/**
 * The Channels page, as on the web: search, count, "Hide flaky" and genre
 * pills; then, on All, Favorites (collapsible, with groups) and Recently
 * Watched; then the channel tiles. Long-press a tile (a held OK on the remote)
 * for its actions; type a channel number on the remote to jump to it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChannelScreen(viewModel: ChannelViewModel, onSelectChannel: (Channel) -> Unit, onOpenPortal: () -> Unit = {}) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val context = LocalContext.current
    val displayed = remember(state.channels, state.selectedGroupId, state.query, state.hideFlaky, state.health) { state.displayed }
    val byId = remember(state.channels) { state.channels.associateBy { it.uniqueId } }
    var menuFor by remember { mutableStateOf<Channel?>(null) }
    var logoFor by remember { mutableStateOf<Channel?>(null) }
    var groupPickFor by remember { mutableStateOf<Channel?>(null) }
    var editGroup by remember { mutableStateOf<FavoriteGroup?>(null) }
    var newGroup by remember { mutableStateOf(false) }
    var genresExpanded by remember { mutableStateOf(false) }
    var searchFocused by remember { mutableStateOf(false) }
    var digits by remember { mutableStateOf("") }

    // Toasts for failed saves.
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }
    // Now/next every 5 minutes and health every minute, while this screen is in front.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            launch { while (true) { delay(5 * 60_000L); viewModel.refreshNowNext() } }
            while (true) { delay(60_000L); viewModel.refreshHealth() }
        }
    }
    // Number jump: the digits typed, then the channel 1.2 s after the last one.
    LaunchedEffect(digits) {
        if (digits.isEmpty()) return@LaunchedEffect
        delay(1_200)
        jumpTarget(state.channels, digits)?.let(onSelectChannel)
        digits = ""
    }

    Column(
        Modifier.fillMaxSize().onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown || searchFocused) return@onPreviewKeyEvent false
            val c = e.utf16CodePoint.toChar()
            if (c.isDigit()) { digits = (digits + c).takeLast(4); true } else false
        },
    ) {
        // Search · count · hide flaky · refresh
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.query, onValueChange = viewModel::setQuery,
                placeholder = { Text("Search channels…") },
                leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
                trailingIcon = if (state.query.isNotEmpty()) ({ IconButton(onClick = { viewModel.setQuery("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
                singleLine = true, shape = RoundedCornerShape(10.dp),
                modifier = Modifier.weight(1f).onFocusChanged { searchFocused = it.isFocused },
            )
            if (state.flaky > 0) {
                Pill(if (state.hideFlaky) "Flaky hidden" else "Hide flaky (${state.flaky})", state.hideFlaky,
                    { viewModel.setHideFlaky(!state.hideFlaky) }, leading = Icons.Default.Warning)
            }
            Text("${displayed.size} ${if (displayed.size == 1) "channel" else "channels"}", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
            IconButton(onClick = { viewModel.load() }) { Icon(Icons.Default.Refresh, "Refresh") }
        }
        // Genre pills: collapsed to one line when there are many.
        if (state.groups.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.Top) {
                val pills: @Composable () -> Unit = {
                    Pill("All", state.selectedGroupId == null, { viewModel.setSelectedGroup(null) })
                    state.groups.forEach { g -> Pill(g.name, state.selectedGroupId == g.id, { viewModel.setSelectedGroup(g.id) }) }
                }
                if (genresExpanded || state.groups.size <= GENRE_COLLAPSE_THRESHOLD) {
                    FlowRow(Modifier.weight(1f).heightIn(max = 240.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { pills() }
                } else {
                    LazyRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item { Pill("All", state.selectedGroupId == null, { viewModel.setSelectedGroup(null) }) }
                        items(state.groups, key = { it.id }) { g -> Pill(g.name, state.selectedGroupId == g.id, { viewModel.setSelectedGroup(g.id) }) }
                    }
                }
                if (state.groups.size > GENRE_COLLAPSE_THRESHOLD) {
                    Pill(if (genresExpanded) "Less" else "More", false, { genresExpanded = !genresExpanded },
                        leading = if (genresExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
        if (state.portalNotConnected) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Default.Router, null, tint = SwColors.Warning)
                Text("Portal not connected — showing cached channels.", color = SwColors.Text, modifier = Modifier.weight(1f))
                TextButton(onClick = onOpenPortal) { Text("Connect") }
            }
        }

        val tile: @Composable (Channel, Boolean) -> Unit = { ch, inFavorites ->
            ChannelTile(
                channel = ch, logoUrl = state.logoMap[ch.uniqueId], isFavorite = ch.uniqueId in state.favoriteIds,
                nowNext = state.nowNext[ch.uniqueId], errors = state.health[ch.uniqueId]?.errors ?: 0,
                onClick = { onSelectChannel(ch) },
                onToggleFavorite = { viewModel.toggleFavorite(ch) },
                onEdit = { logoFor = ch },
                onLongClick = { menuFor = ch },
            )
        }

        LazyVerticalGrid(
            columns = GridCells.Adaptive(if (isTV) 180.dp else 150.dp),
            contentPadding = PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            if (state.browsing) {
                full {
                    SectionHeader(Icons.Default.Favorite, "Favorites", state.favoriteChannels.size, state.favoritesOpen, viewModel::toggleFavoritesOpen)
                }
                if (state.favoritesOpen) {
                    if (state.favoriteChannels.isEmpty() && state.favoriteGroups.isEmpty()) {
                        full { Text("No favorites yet — long-press a channel (or hold OK) to add it.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall) }
                    }
                    items(state.favoriteChannels, key = { "fav-" + it.uniqueId }) { ch -> tile(byId[ch.uniqueId] ?: ch, true) }
                    full { GroupsSection(state.favoriteGroups, state.logoMap, byId, onSelectChannel, onNew = { newGroup = true }, onEdit = { editGroup = it },
                        onDelete = viewModel::deleteGroup, onMove = viewModel::moveGroup) }
                }
                if (state.recentChannels.isNotEmpty()) {
                    full {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            SectionHeader(Icons.Default.History, "Recently Watched", state.recentChannels.size)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp)) {
                                items(state.recentChannels.take(10), key = { "rec-" + it.uniqueId }) { r ->
                                    val ch = byId[r.uniqueId] ?: Channel(uniqueId = r.uniqueId, name = r.name)
                                    Column(Modifier.width(if (isTV) 180.dp else 150.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        ChannelTile(
                                            channel = ch, logoUrl = state.logoMap[ch.uniqueId] ?: r.logoUrl, isFavorite = ch.uniqueId in state.favoriteIds,
                                            nowNext = state.nowNext[ch.uniqueId], errors = state.health[ch.uniqueId]?.errors ?: 0,
                                            onClick = { onSelectChannel(ch) }, onToggleFavorite = { viewModel.toggleFavorite(ch) },
                                            onEdit = { logoFor = ch }, onLongClick = { menuFor = ch },
                                        )
                                        TextButton(onClick = { viewModel.removeRecent(r.uniqueId) }) {
                                            Icon(Icons.Default.Close, null, Modifier.size(12.dp)); Spacer(Modifier.width(4.dp))
                                            Text("Remove", style = MaterialTheme.typography.labelSmall)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                full { SectionHeader(Icons.Default.Tv, "All channels", displayed.size) }
            }
            when {
                state.loading && state.channels.isEmpty() -> full { Box(Modifier.fillMaxWidth().padding(48.dp), Alignment.Center) { CircularProgressIndicator() } }
                state.error != null && state.channels.isEmpty() -> full {
                    EmptyState(Icons.Default.Tv, "Couldn't load channels", state.error) { Button(onClick = { viewModel.load() }) { Text("Retry") } }
                }
                state.portalNotConnected && state.channels.isEmpty() -> full {
                    EmptyState(Icons.Default.Router, "No portal connected", "Connect a portal to load channels.") { Button(onClick = onOpenPortal) { Text("Connect Portal") } }
                }
                displayed.isEmpty() -> full { EmptyState(Icons.Default.Search, "No channels found.") }
                else -> items(displayed, key = { it.uniqueId }) { ch -> tile(ch, false) }
            }
        }
    }

    if (digits.isNotEmpty()) NumberJumpOverlay(digits)

    menuFor?.let { ch ->
        val favIndex = state.favoriteChannels.indexOfFirst { it.uniqueId == ch.uniqueId }
        ChannelActionsDialog(
            channel = ch, isFavorite = ch.uniqueId in state.favoriteIds, canMoveLeft = favIndex > 0,
            canMoveRight = favIndex >= 0 && favIndex < state.favoriteChannels.size - 1, hasGroups = state.favoriteGroups.isNotEmpty(),
            onDismiss = { menuFor = null },
            onToggleFavorite = { viewModel.toggleFavorite(ch) },
            onAddToGroup = { groupPickFor = ch },
            onEditLogo = { logoFor = ch },
            onMove = { delta -> viewModel.moveFavorite(ch, delta) },
        )
    }
    groupPickFor?.let { ch ->
        GroupPickerDialog(state.favoriteGroups, onPick = { g -> viewModel.addToGroup(g, ch) }, onDismiss = { groupPickFor = null })
    }
    logoFor?.let { ch ->
        LogoDialog(ch, onCheck = viewModel::checkLogo, onSave = { url -> viewModel.saveLogo(ch, url) }, onDismiss = { logoFor = null })
    }
    if (newGroup) NameDialog("New group", "", onSave = viewModel::createGroup, onDismiss = { newGroup = false })
    editGroup?.let { g ->
        GroupEditDialog(
            group = g, allChannels = state.channels, logoMap = state.logoMap,
            onRename = { viewModel.renameGroup(g, it) },
            onAdd = { viewModel.addToGroup(g, it) },
            onRemove = { viewModel.removeFromGroup(g, it) },
            onDismiss = { editGroup = null },
        )
    }
}

private fun LazyGridScope.full(content: @Composable () -> Unit) = item(span = { GridItemSpan(maxLineSpan) }) { content() }

/** The Favorites groups: a row each with a logo preview, count and actions; New group. */
@Composable
private fun GroupsSection(
    groups: List<FavoriteGroup>, logoMap: Map<String, String>, byId: Map<String, Channel>, onOpen: (Channel) -> Unit,
    onNew: () -> Unit, onEdit: (FavoriteGroup) -> Unit, onDelete: (FavoriteGroup) -> Unit, onMove: (FavoriteGroup, Int) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionHeader(Icons.Default.Layers, "Groups", groups.size)
            Spacer(Modifier.weight(1f))
            Pill("New group", false, onNew, leading = Icons.Default.Add)
        }
        groups.forEachIndexed { i, g ->
            GroupRow(g, logoMap, byId, onOpen, canUp = i > 0, canDown = i < groups.size - 1,
                onEdit = { onEdit(g) }, onDelete = { onDelete(g) }, onMove = { d -> onMove(g, d) })
        }
    }
}
```

## Appendix C: `ui/channels/ChannelDialogs.kt`

```kotlin
package com.stalkerweb.android.ui.channels

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.FavoriteGroup
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** "Jump to channel 101" — the digits typed on the remote. */
@Composable
fun NumberJumpOverlay(digits: String) {
    Box(Modifier.fillMaxWidth().padding(bottom = 48.dp), contentAlignment = Alignment.BottomCenter) {
        Surface(color = SwColors.Bg.copy(alpha = 0.9f), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(horizontal = 24.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Jump to channel", style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                Text(digits, style = MaterialTheme.typography.headlineMedium, color = SwColors.PrimaryLight)
            }
        }
    }
}

@Composable
private fun ActionRow(icon: ImageVector, label: String, focus: FocusRequester? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = SwColors.Muted)
        Text(label, color = SwColors.Text)
    }
}

/** A tile's actions — long-press (a held OK) opens it, so the remote reaches every one. */
@Composable
fun ChannelActionsDialog(
    channel: Channel, isFavorite: Boolean, canMoveLeft: Boolean, canMoveRight: Boolean, hasGroups: Boolean,
    onDismiss: () -> Unit, onToggleFavorite: () -> Unit, onAddToGroup: () -> Unit, onEditLogo: () -> Unit, onMove: (Int) -> Unit,
) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(channel.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column {
                ActionRow(if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                    if (isFavorite) "Remove from favorites" else "Add to favorites", first) { onToggleFavorite(); onDismiss() }
                if (hasGroups) ActionRow(Icons.Default.Layers, "Add to group…") { onAddToGroup(); onDismiss() }
                ActionRow(Icons.Default.Edit, "Edit logo") { onEditLogo(); onDismiss() }
                if (canMoveLeft) ActionRow(Icons.AutoMirrored.Filled.ArrowBack, "Move left in Favorites") { onMove(-1); onDismiss() }
                if (canMoveRight) ActionRow(Icons.AutoMirrored.Filled.ArrowForward, "Move right in Favorites") { onMove(1); onDismiss() }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
fun GroupPickerDialog(groups: List<FavoriteGroup>, onPick: (FavoriteGroup) -> Unit, onDismiss: () -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add to group") },
        text = {
            LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(groups, key = { it.id }) { g ->
                    ActionRow(Icons.Default.Layers, g.name, if (g.id == groups.first().id) first else null) { onPick(g); onDismiss() }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A name: a new group, or a group renamed. */
@Composable
fun NameDialog(title: String, initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(initial) }
    val field = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") }, modifier = Modifier.focusRequester(field)) },
        confirmButton = { Button(onClick = { onSave(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Search a name for the logo the server finds, or paste a URL; Save sets it for that channel name. */
@Composable
fun LogoDialog(channel: Channel, onCheck: suspend (String) -> String?, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var search by remember { mutableStateOf(channel.name) }
    var found by remember { mutableStateOf<String?>(null) }
    var notFound by remember { mutableStateOf(false) }
    var url by remember { mutableStateOf("") }
    LaunchedEffect(search) {
        found = null; notFound = false
        if (search.isBlank()) return@LaunchedEffect
        delay(400)
        val logo = onCheck(search.trim())
        found = logo; notFound = logo == null
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Set logo — ${channel.name}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(search, { search = it }, singleLine = true, label = { Text("Search by channel name") })
                found?.let { logo ->
                    Row(
                        Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { url = logo }
                            .background(if (url == logo) SwColors.Surface3 else SwColors.Surface2, RoundedCornerShape(8.dp)).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AsyncImage(logo, null, Modifier.size(40.dp), contentScale = ContentScale.Fit)
                        Text(if (url == logo) "Selected" else "Use this logo", color = SwColors.Text)
                    }
                }
                if (notFound) Text("No logo found", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(url, { url = it }, singleLine = true, label = { Text("Or paste a logo URL") })
            }
        },
        confirmButton = { Button(onClick = { onSave(url); onDismiss() }, enabled = url.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A favorites group's row: logo preview, name and count; expand to its channels; edit, delete, move. */
@Composable
fun GroupRow(
    group: FavoriteGroup, logoMap: Map<String, String>, byId: Map<String, Channel>, onOpen: (Channel) -> Unit,
    canUp: Boolean, canDown: Boolean, onEdit: () -> Unit, onDelete: () -> Unit, onMove: (Int) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)).background(SwColors.Surface2)) {
                    group.channels.take(2).forEach { ch ->
                        AsyncImage(logoMap[ch.uniqueId], null, Modifier.size(24.dp).padding(2.dp), contentScale = ContentScale.Fit)
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(group.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${group.channels.size} channel${if (group.channels.size == 1) "" else "s"}", style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                }
                IconButton(onClick = { expanded = !expanded }) { Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (expanded) "Collapse" else "Expand") }
                if (canUp) IconButton(onClick = { onMove(-1) }) { Icon(Icons.Default.KeyboardArrowUp, "Move group up") }
                if (canDown) IconButton(onClick = { onMove(1) }) { Icon(Icons.Default.KeyboardArrowDown, "Move group down") }
                IconButton(onClick = onEdit) { Icon(Icons.Default.Edit, "Edit group") }
                IconButton(onClick = { confirmDelete = true }) { Icon(Icons.Default.Delete, "Delete group", tint = SwColors.Live) }
            }
            if (expanded) {
                if (group.channels.isEmpty()) Text("No channels — edit the group to add some.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(group.channels, key = { it.uniqueId }) { c ->
                        val ch = byId[c.uniqueId] ?: c
                        Column(
                            Modifier.width(96.dp).tvFocus(RoundedCornerShape(8.dp)).clickable { onOpen(ch) }.padding(6.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Box(Modifier.size(40.dp).clip(RoundedCornerShape(6.dp)).background(SwColors.Surface2), Alignment.Center) {
                                val logo = logoMap[ch.uniqueId]
                                if (logo != null) AsyncImage(logo, ch.name, Modifier.size(36.dp), contentScale = ContentScale.Fit)
                                else Icon(Icons.Default.Tv, null, Modifier.size(18.dp), tint = SwColors.Muted)
                            }
                            Text(ch.name, style = MaterialTheme.typography.labelSmall, color = SwColors.Text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete ${group.name}?") },
            text = { Text("The group goes; its channels stay in your favorites.") },
            confirmButton = { Button(onClick = { confirmDelete = false; onDelete() }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

/** Rename a group, remove its channels, add channels from a search. */
@Composable
fun GroupEditDialog(
    group: FavoriteGroup, allChannels: List<Channel>, logoMap: Map<String, String>,
    onRename: (String) -> Unit, onAdd: (Channel) -> Unit, onRemove: (Channel) -> Unit, onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(group.name) }
    var members by remember { mutableStateOf(group.channels) }
    var query by remember { mutableStateOf("") }
    val ids = members.map { it.uniqueId }.toSet()
    val suggestions = remember(query, ids) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) emptyList() else allChannels.filter { it.uniqueId !in ids && it.name.lowercase().contains(q) }.take(20)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit group") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") })
                Text("Channels in group", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
                LazyColumn(Modifier.heightIn(max = 160.dp)) {
                    items(members, key = { "m" + it.uniqueId }) { c ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(c.name, color = SwColors.Text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            IconButton(onClick = { onRemove(c); members = members.filter { it.uniqueId != c.uniqueId } }) { Icon(Icons.Default.Close, "Remove ${c.name}") }
                        }
                    }
                }
                OutlinedTextField(query, { query = it }, singleLine = true, label = { Text("Search channels to add…") })
                LazyColumn(Modifier.heightIn(max = 180.dp)) {
                    items(suggestions, key = { "s" + it.uniqueId }) { c ->
                        Row(
                            Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { onAdd(c); members = members + c; query = "" }.padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.Default.Add, null, Modifier.size(16.dp), tint = SwColors.Muted)
                            Text(c.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = { if (name.trim() != group.name) onRename(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Done") } },
    )
}
```
