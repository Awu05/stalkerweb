# Android parity, part 1: app shell, viewers and theme

Date: 2026-10-12
Status: approved design, awaiting spec review

## Context

The Android app (`android/`, Jetpack Compose, with `mobile` and `tv` APK flavors) has fallen behind the web app. The goal is for the Android app on a TV or a phone to give the same experience as the browser: the same person, favorites, history and lists, the same main features, and the same look. Every screen has to work equally well with touch and with a TV remote (D-pad).

This is split into four sub-projects. Each one gets its own spec, plan and PR into main, and **nothing is released until all four are merged**:

1. **Shell, viewers and theme** (this spec)
2. VOD parity: resume, Recently watched, My List, filters, sort, Movies/Series "All", the episode panel with Next/Prev and auto-play next
3. Live TV parity: the collapsible Favorites section with groups, the Recently Watched row, consistent tiles, and a favorite button in the player
4. Guide (EPG grid), Downloads, and the Settings tabs (Viewers, Connection, Links, Playback, Logos)

The approach chosen is **native and restructured**. The app stays native Compose with ExoPlayer, keeping casting, picture-in-picture, the sleep timer and stream overrides. It is reorganised to match the web app's structure, so later web features have an obvious place to go.

## Goals

- An app shell with the web's sections, which works with both the D-pad and touch.
- Data access split by area, with every request carrying the access key and the chosen viewer.
- "Who's watching?" viewers that behave as they do on the web.
- The web's "Midnight Cinema" look: colours, font, shapes, and shared tile components.
- The connected IPTV connection's name always visible.
- Unit tests for the new logic, run in CI.

## Non-goals (handled in later sub-projects)

- New live TV or VOD features (sub-projects 2 and 3). Existing screens are moved into the shell and re-skinned, but their features don't change here.
- Renaming or deleting viewers, and editing viewer filters (sub-project 4, Settings → Viewers).
- Guide, Downloads and Settings content. They appear in the shell as placeholders.

## Design

### 1. Layers

```
ui/shell, ui/<section>  →  data/repo  →  data/api  →  server
```

**`data/api`**
- `StalkerApi`, the Retrofit interface, gains the endpoints this part needs:
  - `GET /api/viewers` returns `{ viewers }`.
  - `POST /api/viewers` with `{ name }` returns the new viewer.
  - `GET /api/viewers/me` returns the current viewer with `showAdult`, `disabledGenres` and `disabledLanguages`.
- **One OkHttp client.** An interceptor adds:
  - `Authorization: Bearer <access key>`, when a key is set (as today);
  - `X-Viewer: <viewer id>`, when a viewer is chosen, read on every request so that a switch takes effect at once.
- **Error mapping.** A small `ApiError` mapping turns HTTP responses into typed errors:
  - 401 with `accessRequired` → `AccessDenied(message)`
  - 429 → `LockedOut(message)`
  - 409 with `viewerGone` → `ViewerGone`
  - a network failure → `Unreachable`
  - anything else → `Failed(message)`

  The server's `error` text is kept as the message.

**`data/repo`** replaces the single `ChannelRepository`:
- `ServerRepository`: the server address, the access key, `getStatus()`, testing a server, and the saved IPTV connections (`/api/profiles`).
- `ViewerRepository`: the viewer list, the current viewer (`StateFlow<Viewer?>`), choosing, creating and refreshing a viewer, and the device's saved viewer id.
- `LiveRepository`: the existing channel, group, now-next, favorites, logo-map, stream-resolve and stream-override code, moved over unchanged.
- `VodRepository`: the existing VOD categories, items, seasons, episodes and stream code, moved over unchanged.
- `WatchRepository`: an empty placeholder that sub-project 2 fills in.

An `AppContainer`, created once in `StalkerWebApp`, builds the API client and the repositories. Screens and ViewModels get repositories from it, with no DI library. `AppPrefs` keeps its current role and gains `viewerId`.

**Clearing caches on a switch.** When the viewer changes, `ViewerRepository` emits an event. `LiveRepository` and `VodRepository` respond by dropping anything cached for a viewer: favorites, filtered channel lists and, later, watch data.

### 2. App shell (`ui/shell`)

- **Sections:** Channels, VOD, Downloads, Guide. At the bottom: the viewer avatar, the connection name, and Settings.
- **Layout by window width, not by flavor:**
  - **Wide** (Compose `WindowWidthSizeClass` Expanded/Medium; TVs, tablets in landscape): a left **side rail** with icons, expandable to icons with labels on focus or tap. On TV, pressing left from the content's left edge moves focus into the rail, and pressing right returns it.
  - **Compact** (phones): a **bottom bar** with the four sections. A top bar on each section shows the viewer avatar; tapping it opens a menu with "Switch viewer", the connection name and Settings.
- **Outside the shell:** Setup, the "Who's watching?" screen and the two players are full-screen destinations.
- **Placeholders:** Downloads, Guide and Settings show an `EmptyState` saying "Coming soon" until sub-project 4.
- **Unreachable banner:** when the server can't be reached, the shell shows a banner with Retry across the top of the content. Cached channels still show, as they do today.

### 3. Viewers

- **Startup** follows the web's v0.4.29 rule: use the saved viewer id if it still exists in `GET /api/viewers`, otherwise show "Who's watching?", even when only one viewer exists. This logic is a pure function, `chooseViewer(viewers, savedId)`, in `data/repo/ViewerChoice.kt`, mirroring `frontend/src/lib/viewer.js`.
- **"Who's watching?" screen (`ui/viewers/ViewerPickerScreen`):**
  - A grid of `ViewerAvatar` tiles (initial and colour, as on the web), each focusable and big enough to tap.
  - An "Add viewer" tile that opens a name field and creates the viewer through `POST /api/viewers`, then chooses it. Name errors from the server (empty, duplicate, too long) show under the field.
  - **Required mode** (startup, a viewer gone, or a changed server or key): there's no close, and Back leaves the app rather than skipping the choice.
  - **Optional mode** (from the avatar): it has a close button, and Back dismisses it.
- **When it is shown in required mode:**
  - after Setup completes;
  - after the server address or access key is changed in Setup, when the saved viewer id is cleared;
  - on any `ViewerGone` error, when the saved id is cleared.
- **Switching** saves the id, emits the change event, reloads `/api/viewers/me`, and navigates to the top of the current section. Players are left first, as on the web.
- **Filters.** The live channel filter comes from the viewer (`disabledGenres`, `disabledLanguages` and `showAdult` from `/api/viewers/me`). This replaces `ChannelRepository`'s per-profile `FilterSet`, which predates viewers. The current matching (genre names, language prefixes, adult words) moves into a pure `ViewerFilter`, written to match `frontend/src/pages/ChannelsPage.jsx` and `lib/languages.js`.

### 4. Theme and shared components (`ui/theme`, `ui/components`)

**Colours** use the web's names, defined once in `Theme.kt`:

| Token | Value |
|-------|-------|
| `bg` | `#141417` |
| `surface` | `#1c1c20` |
| `surface2` | `#232328` |
| `surface3` | `#28282e` |
| `border` | `#28282e` |
| `text` | `#e8e8ec` |
| `muted` | `#9696a0` |
| `primary` | `#e8e8ec` |
| `primaryLight` | `#ffffff` |
| `live` | `#ef4444` |
| `success` | `#5bc39d` |
| heart | rose `#f43f5e` |
| warning | amber `#fbbf24` |

They are mapped onto the Material 3 dark colour scheme, and the old amber palette and gradient backdrop are removed.

**Other tokens:**
- **Font:** Outfit (OFL licence), bundled in `res/font` in weights 400, 500, 600 and 700, and mapped onto the Material `Typography`.
- **Shapes:** radii of 8, 10 and 12 dp, matching the web's small, medium and large.
- **Focus:** a shared `Modifier.tvFocus()` draws a 2 dp white ring and scales the item by 1.03 when it is focused. Corner buttons on tiles show on focus, as they do on hover on the web.

**Components:**
- `ChannelTile`: the web's fixed shape. A logo, "Ch N", a two-line name and a guide strip, with heart and edit corner buttons and a health warning.
- `PosterTile`: a 2:3 poster with corner bookmark and download buttons, an HD badge at the bottom right, a title and the year.
- `Pill`, `SectionHeader` (icon, title and count, which can collapse), `RowStrip` (a horizontal row with D-pad-friendly scrolling), `ViewerAvatar` and `EmptyState`.

The existing Channels, VOD, Setup and player screens adopt the theme and these components where they map directly. Layout changes for those screens belong to sub-projects 2 and 3.

### 5. Connection name

- `connectionLabel(status, profiles)` returns `{ name, host }` or null. It's a pure function that mirrors `frontend/src/lib/connection.js`: the profile whose portal and MAC both match, otherwise one whose portal matches, otherwise the portal's host.
- **Where it shows:** under the viewer avatar in the rail, and in the phone's avatar menu.
- **Updates:** on a new status poll in the shell (`GET /api/auth/status` every 30 s while the app is in the foreground, as on the web), and right after a connect or switch.

### 6. Sign-in and access errors

- The access key stays on the Setup screen and is sent as `Authorization` on every request.
- Setup shows the server's own message for `AccessDenied` and `LockedOut`, so the new "N tries left" and "try again in …" text appears there.
- An `AccessDenied` or `LockedOut` error after setup (the key was changed, or this address is locked out) sends the app back to Setup with that message.

### 7. Errors

| Error | Behaviour |
|-------|-----------|
| `ViewerGone` | Clear the saved viewer and show the picker in required mode. |
| `Unreachable` | Show the shell banner with Retry, and keep the cached data on screen. |
| `Failed` in a section | That section shows the message with a Retry button, and the app doesn't crash. |

## Testing

New JVM unit tests go in `android/app/src/test/` (JUnit 4 and kotlinx-coroutines-test):

- `chooseViewer`: keeps the saved viewer while it exists, and asks when none is saved, when the saved one is gone, and when only one exists.
- `connectionLabel`: matches by portal and MAC, falls back to the portal alone, then to the host, and returns null when disconnected.
- The header interceptor: adds both headers when set and leaves each out when unset, and a viewer switch shows on the next request.
- `ApiError` mapping: 401 with `accessRequired`, 429, 409 with `viewerGone`, a network failure, and a 500 with a message.
- `ViewerFilter`: genres, languages and adult content, against the same cases as the web.

CI (`.github/workflows/ci.yml`, job `build-apk`) adds `gradle :app:testMobileDebugUnitTest` before the APK builds. Screens get `@Preview`s but no device tests.

**Building:** this development machine has no JDK or Gradle, so compiling and tests run in CI on each push.

## Rollout

- One PR into main for this sub-project.
- The APKs are built by CI, and there is no release until sub-projects 2 to 4 are also merged.
- Existing installs keep working after the update:
  - The saved server address and access key are kept.
  - The saved viewer starts empty, so the first launch shows "Who's watching?".
