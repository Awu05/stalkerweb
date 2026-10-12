# Android parity, part 3: Live TV

Date: 2026-10-12
Status: design approved

Builds on parts 1–2:
- the shell, viewers, `AccessGuard`, `ChannelTile`, `SectionHeader`, `RowStrip`, `Pill` and `tvFocus`;
- `LiveRepository`, which is per viewer and has the viewer filter and the per-viewer channel cache.

## Context

The web's Channels page (`frontend/src/pages/ChannelsPage.jsx`, `components/FavoritesView.jsx`, `components/ChannelCard.jsx`) has:
- search, the channel count, "Hide flaky (N)", and collapsible genre pills;
- a collapsible Favorites section with groups (create, rename, delete; add and remove channels; reorder);
- a Recently Watched row;
- a grid of fixed-shape tiles showing now/next, the flaky warning, a heart and logo editing;
- jumping to a channel by typing its number.

The Android app has a list of rows with All / Favorites tabs, and none of the above. Its player already has favorites, a channel list, the sleep timer and stream overrides. The server provides everything per viewer:
- `/api/favorites*`
- `/api/channels/health`, which returns `{ uniqueId: { errors, lastError } }`
- `/api/epg/now`
- `/api/logos/check?name=`, which returns `{ logo, name }`
- `POST /api/logos`, taking `{ name, url }`

## Goals

1. **The Channels screen with the web's layout and features**, on touch and the remote:
   - **Top:**
     - a search field, which filters by name as you type;
     - the count of channels shown;
     - a "Hide flaky (N)" toggle, shown when any channel has 2 or more recent errors (`FLAKY_THRESHOLD`);
     - a genre pill row of All plus the visible groups, collapsed to one line above 12 pills, with More/Less.
   - **Favorites:** on All, with no search, a collapsible section remembered per device (`AppPrefs.favoritesOpen`, default open), showing:
     - favorite channels as `ChannelTile`s in the grid's columns;
     - the groups. Each group is a row: a 2×2 logo preview, the name, the count, and actions to expand, edit and delete. Editing renames the group, removes channels from it, and adds channels from a search.
     - "New group", which asks for a name.
   - **Recently Watched:** on All, with no search, a row of the same tiles from this device's history, each with Remove.
   - **The grid:** a lazy grid of `ChannelTile`s with `GridCells.Adaptive(150.dp)`, or `180.dp` on TV. It shows now/next from `/api/epg/now` (refreshed every 5 minutes), health from `/api/channels/health` (refreshed every 60 s), and favorites.
   - **Number jump:** pressing digit keys on the remote collects up to 4 digits and shows them in an overlay. 1.2 s after the last digit it opens the channel with that number, if there is one. Escape or Back clears the digits.
2. **Tile actions that work everywhere.** Long-press, which is a held OK on the remote, opens a menu:
   - Add to / Remove from favorites
   - Add to group… (then pick a group)
   - Edit logo
   - Move left / Move right (only on a favorite tile, to reorder favorites)

   On touch, the heart and edit corner buttons stay. The corner buttons leave `ChannelTile`'s focus order, so the remote focuses the tile only. This fixes part 1 review item M6.
3. **Edit logo dialog.** It shows the channel name. Search a name to see the logo the server finds, or paste a URL, then Save. Save posts `{ name, url }` and refreshes the logo map.
4. **Player:** a short toast confirming "Added to favorites" or "Removed from favorites". The favorite IDs it shows are the current viewer's (already true through `X-Viewer`), and they reload when the viewer switches.

## Design

### Data

`LiveRepository` gains:
- `getFavorites(): FavoritesResponse`, which includes channels and groups;
- `createGroup(name)`, `renameGroup(id, name)` and `deleteGroup(id)`;
- `addToGroup(groupId, uniqueId)` and `removeFromGroup(groupId, uniqueId)`;
- `reorderFavorites(order)` and `reorderGroups(order)`;
- `getHealth(): Map<String, ChannelHealth>`;
- `checkLogo(name): LogoCheck?` and `setLogoOverride(name, url)`.

The matching Retrofit endpoints go in `StalkerApi`. The models go in `data/api`: `ChannelHealth(errors, lastError)`, `LogoCheck(logo, name)`, `NameRequest(name)`, `OrderRequest(order)` and `LogoOverrideRequest(name, url)`.

### Pure logic (`data/repo/LiveRules.kt`), tested

- `filterChannels(channels, groupId, query, hideFlaky, health)` applies, in the web's order:
  - the genre (`genreId == groupId`)
  - the name search (case-insensitive)
  - the flaky filter (errors below 2 are kept)
- `flakyCount(channels, health)`
- `jumpTarget(channels, digits)` returns the channel whose `number` equals the digits, or null.
- `moveItem(list, index, delta)` returns the list with one item moved within bounds; at either end it's unchanged.

### UI

**`ChannelViewModel`** is rewritten. Its state holds:
- channels, groups, the logo map, now/next, health and favorites (channel IDs plus `FavoritesResponse` for the section);
- the query, the selected group, hide flaky and favorites open;
- loading, the error and the backend's "still loading" flag;
- `recent`.

It keeps the existing load-from-cache-then-network behaviour and the per-viewer reload on `viewers.changes`. The polls are:
- now/next every 5 minutes;
- health every 60 s, while the screen is started.

**`ChannelScreen`** is rewritten as one `LazyVerticalGrid` with full-span header items:
1. Favorites
2. Recently Watched
3. Status
4. The tiles

The top bar, filter row and pills sit above the grid. The menu, logo dialog, group dialogs and number overlay are separate composables in `ui/channels/`.

On TV, initial focus goes to the first tile, or the first favorite when Favorites is open.

### Errors

- A failed favorites or groups call shows a toast ("Couldn't save — try again") and reloads favorites.
- A failed logo search shows "No logo found" and keeps the URL field.

## Testing

JVM tests for `LiveRules`:
- `filterChannels`: genre, search, flaky and combined
- `flakyCount`
- `jumpTarget`: hit, miss, leading zeros
- `moveItem`: middle, ends and out of range

The UI is covered by the shared device checklist.

## Rollout

- Branch `feat/android-live`, stacked on `feat/android-vod`, with a draft PR into main.
- No release until part 4 is done and you've tested on your devices.
