# Android parity, part 2: VOD

Date: 2026-10-12
Status: design approved
Builds on: part 1 (`docs/superpowers/specs/2026-10-12-android-parity-1-shell-viewers-theme-design.md`): shell, viewers, `ApiProvider`/`AccessGuard`, `PosterTile`, `RowStrip`, `Pill`, `SectionHeader`, `tvFocus`.

## Context

The web app's VOD has these features, and the Android app has none of them:
- Recently watched, with resume
- My List, with To watch and Completed sections
- filters and A–Z / Newest sorting
- Movies and Series "All"
- an episode panel with Previous and Next, and auto-play of the next episode

The server already provides everything, per viewer and per portal:
- the `/api/vod/watch*` routes (backend `viewers/WatchStore.js`)
- `/api/vod/listing`, which reads a whole category
- `/api/vod/items` and `/api/vod/categories` (including `movies:all` / `series:all`)

So part 2 is Android work only. Watch data is shared with the web, so a title started on the TV resumes on the phone and on the web, and the other way round.

## Goals

- `WatchRepository`, which mirrors the web's `lib/vodProgress.js`.
- A VOD screen with the web's layout and features.
- A VOD player with resume, progress saving, the episode panel, Previous/Next, auto-play next, and a My List button.
- Every control works with the D-pad and with touch.
- Unit tests that port the web's test cases.

## Non-goals

- Server downloads; the download buttons come in part 4.
- The live channel screen (part 3).

## Design

### 1. Data

**Models** (`data/api`, Moshi):
- `VodItem` gains `genres: List<String>`, `rating: Double`, `added: String`, `episodes: List<String>`, `description`, `director` and `actors`. These are the fields the server already sends.
- `WatchState` holds:
  - `progress`: a list of `ProgressEntry(key, title, episodeTitle, screenshotUrl, params, position, duration, updatedAt)`
  - `history`: a list of `HistoryEntry(id, key, title, episodeTitle, screenshotUrl, params, position, duration, finished, updatedAt)`
  - `watched`: a list of title ids
  - `list`: a list of `ListEntry(id, item: VodItem, addedAt, completedAt)`
- `SaveWatchRequest(key, title, episodeTitle, screenshotUrl, params, position, duration, lastEpisode)` and `CompletedRequest(completed)`.
- `ListingResponse(items, loaded, total, complete, partial, error)`.

**API** (`StalkerApi`):
- `GET api/vod/watch` and `PUT api/vod/watch`
- `DELETE api/vod/watch/history/{id}` and `DELETE api/vod/watch/history`
- `PUT api/vod/watch/list`, `DELETE api/vod/watch/list/{id}` and `PUT api/vod/watch/list/{id}/completed`
- `GET api/vod/listing?type&category&from`
- `getVodItems` gains `sort`

Every watch call answers with the viewer's whole `WatchState`.

**`WatchRepository`** (`data/repo`) has `state: StateFlow<WatchState>`.
- `load()` runs at startup and when `ViewerRepository.changes` moves. A viewer switch clears the state immediately.
- It has `saveProgress(entry)`, `removeFromHistory(id)`, `clearHistory()`, `toggleMyList(item)` and `setCompleted(id, completed)`.
- **Optimistic updates:** changes to the list and history show at once.
- **Answer ordering:** answers are applied by request number, the same rule as the web's `vodProgress.js`. An answer is used only if its number is greater than the last one answered and at least the number of the latest local change, so a stale answer can't undo a My List change. This rule is a pure class, `RequestOrder`, which is tested.
- **Queries:**
  - `progressFor(key)`
  - `isInMyList(id)`
  - `watchedIds()`: watched, history and progress ids, as on the web

**Player link format (`PlayerParams`).** History and My List entries carry the web player's query string. `PlayerParams` reads and writes it exactly as the web does:
- **Keys:** `videoId`, `title`, `cmd`, `series`, `seasonId`, `episodeId`, `episodeTitle`, `year`, `durationMin`, `isHD`, `screenshotUrl`, `description`, `director`, `actors`.
- **Encoding:**
  - The query is `application/x-www-form-urlencoded`, like `URLSearchParams`.
  - `screenshotUrl`, `description`, `director` and `actors` are additionally `encodeURIComponent`-encoded inside it, as the web's `buildPlayerParams` does.
- **Poster links:** `screenshotUrl` is stored relative to the server (`/api/logos/render?url=…`). The app adds its own server address when showing it, so the web shows posters saved from the TV, and the other way round.

**Watch rules (`WatchRules`, pure).** These mirror the backend constants:
- `RESUME_MIN_SECS = 30`
- `DONE_FRACTION = 0.95`
- `resumeAt(saved, duration)` gives the position to resume from, or null:
  - when `saved.position ≥ 30` and `saved.position < duration × 0.95`, it's the saved position;
  - otherwise null.
- `makeKey(videoId, seasonId, episodeId)` gives `"id"` or `"id:season:episode"`.

**Filters and sorting (`VodFilters`, pure).** A port of `frontend/src/lib/vodFilters.js`:
- `VodFilterState(genre, year, minRating, addedDays, hd, unwatched)` with `isActive`
- `decadeOf(year)`
- `sortVodItems(items, sort)`:
  - `"name"`: natural order, ignoring case
  - `"added"`: newest first; undated titles go last, by name
- `applyVodFilters(items, filters, watched, search, now)`
- `filterOptions(items)`:
  - genres, A–Z
  - years, newest first, while there are 12 or fewer; otherwise decades, with "Older" last
  - `hasRating`, `hasHD`

**Episode order (`EpisodeNav`, pure).** A port of `frontend/src/lib/episodeNav.js`:
- `episodeNeighbours(seasons, episodesBySeason, seasonId, episodeId)` returns `(prev, next, needs)`.
- `isLastEpisode` is true only when this season and this episode are both found, and there's no next one.

### 2. VOD screen (`ui/vod`)

**Layout:**
- **Header:** Movies and Series tabs, then a search field, the filter bar and the sort toggle.
- **Wide screens and TV:** the category list sits in a left column, 220 dp wide, as on the web.
- **Phone:** the category list is a single pill row that scrolls sideways.

**Categories, in order:**
1. **My List**
2. The server's categories, including an added "All". The first real category opens by default, as on the web.

**Search:**
- The search text is kept when switching category.
- In paged mode it's sent to `/items`, after a 400 ms debounce.
- In whole-listing mode it filters locally.

**Filter bar** (`Pill`s and dropdown menus):
- **Year:** years or decades, from `filterOptions`.
- **Added:** 7, 30 or 90 days.
- **Genre**
- **Rating:** 6+, 7+ or 8+, shown only when the titles have ratings.
- **HD:** shown only when some titles are HD.
- **Not watched**

A filter with nothing to pick is hidden.

**Sort:** A–Z / Newest, remembered per device (`AppPrefs.vodSort`, default `"name"`).

**Modes:**
- **Paged:** `/items` with `sort` and `search`, loading more at the end of the grid. This is the default, and is used for the portal's "All".
- **Whole listing:** used when a filter is on in a category other than the portal's "All", and always for an added "All" (`movies:all`, `series:all`).
  - The app polls `/listing` every 1.2 s until it's complete, showing "Reading titles… N of M".
  - The listing is filtered, searched and sorted locally, and shown 140 titles at a time.
  - A listing `error` shows instead of polling.

**Rows:** when no filter or search is active and My List isn't open, two rows appear above the grid:
- **Recently watched:** this tab's entries (movies, or shows).
  - Unfinished entries show a progress bar; finished ones a "Watched" badge.
  - Each entry has a remove button, and the row has a Clear button.
  - Selecting an unfinished entry resumes it; a finished movie plays again; a finished show opens its seasons.
- **My List:** this tab's "to watch" titles, plus a "See all" link that opens My List.

**Grid:** `PosterTile`s with a bookmark that toggles My List. Columns adapt to width: `GridCells.Adaptive(140.dp)`, or `180.dp` on TV.

**My List view:**
- **To watch** and **Completed** sections, each searched, filtered and sorted.
  - "Newest" is the order titles were added.
  - Each title has "Mark completed" or "Back to To watch".
- **Empty state:** "No movies (or shows) on My List yet".

**Seasons pop-up (a series):**
- Seasons and episodes in order, the My List button, and episode rows that open the player.
- It opens as a full dialog on TV and a bottom sheet on a phone.

### 3. VOD player (`ui/vod/VodPlayerScreen`, `VodPlayerViewModel`)

**Arguments:** the player route carries one argument, `params`: a `PlayerParams` query, the same as the web player's link.

**Resume:**
- When the media's duration is known for this title (the `mediaKey` guard from web v0.4.28), apply `resumeAt`.
- Show "Resumed from mm:ss · Start over" for 8 s.

**Saving progress:**
- Every 10 s while playing, on pause and when leaving.
- Only for the media that's actually playing, so an in-place episode switch can't save the old episode's position under the new key.
- The save includes `lastEpisode` (from `EpisodeNav`), so finishing a show's last episode completes it on My List.

**Episodes (a show):**
- **Panel:** a list of seasons and their episodes. On TV and wide screens it's a side panel that toggles; on a phone it's a sheet.
- **Previous / Next:** buttons, plus the remote's `MEDIA_PREVIOUS` / `MEDIA_NEXT` keys and `KEYCODE_CHANNEL_DOWN` / `UP`.
- **Switching episode:** the title is replaced in place. Seasons that are needed load on demand.
- **Auto-play:** after an episode ends, an "Up next" card counts down 10 s. Play now / Cancel; if not cancelled, the next episode plays.

**Seek bar:** dragging moves a preview; the seek happens once on release (web v0.4.27).

**My List:** a button in the player's info area.

### 4. Remote and touch

- **Corner buttons:** a `PosterTile` with a bookmark stops being one focus target.
  - The poster is focusable, and the bookmark becomes a second focus stop reached with D-pad Right (fixing part 1 review item M6).
  - On touch it's always shown.
- **Rows and grids:** they keep focus on scroll, and the first category gets focus on TV.
- **Player:**
  - D-pad Left and Right seek by 10 s.
  - Up shows the controls.
  - Down opens the episodes panel when it's a show.

### 5. Errors

- **Watch calls failing:** optimistic changes are rolled back by reloading the state, as the web does. The app doesn't crash.
- **Listing error:** the message replaces "Reading titles…".
- **Player stream failure:** the existing error card stays, with Retry.

## Testing

JVM unit tests (JUnit 4):
- **`VodFilters`:** the cases from `frontend/src/lib/vodFilters.test.js` (filters, sorting, options, decades).
- **`EpisodeNav`:** the cases from `episodeNav.test.js`, plus `isLastEpisode`, including the case where seasons fail to load.
- **`RequestOrder`:**
  - a stale progress answer doesn't undo a later My List change;
  - an older answer doesn't replace a newer one.
- **`PlayerParams`:**
  - round trip;
  - matches a query string produced by the web's `buildPlayerParams` (fixture), including the double-encoded fields;
  - a relative poster path is kept.
- **`WatchRules`:** the resume and done thresholds, and keys.

The UI is covered by the shared device checklist, after all four parts are done.

## Rollout

- One PR into main: `feat/android-vod`, stacked on part 1's branch. CI runs on PRs into main, and the diff includes part 1 until #57 is merged.
- No release until all four parts are merged.
