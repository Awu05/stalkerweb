# Viewer profiles — design

Date: 2026-10-08
Status: approved in chat, awaiting spec review

## Goal

Several people share one StalkerWeb server. Each person should have their own
**favorites** and their own choice of **which channels are shown** (hidden
genres, hidden languages, Show Adult Content), without affecting anyone else.
Everything else stays shared and behaves exactly as today: the portal
connection and portal profiles, live buffer, idle auto-disconnect, EPG/VOD
switches, download folder, STB emulation, access key.

Success looks like: two people on two devices pick different viewers, star
different channels and hide different genres, and each sees only their own
choices on the website and in the playlist / Xtream / Stremio links they use.

## Decisions (from the brainstorm)

- **Viewer profiles**, Netflix-style, separate from portal profiles. All viewers
  share the one active portal connection.
- **Chosen with a "Who's watching?" picker**, remembered per device. No PINs.
  Anyone with full access can create, rename, recolor, delete and switch
  viewers. This separates people's lists; it does not stop someone opening
  another viewer.
- **Server-side storage**, so a viewer is the same on every device and external
  apps can follow it.
- **Android app:** keeps using the default viewer for now; a picker there is a
  separate follow-up.
- Favorites keep storing the portal's channel ids, as today, so favorites made
  on one provider do not match channels on another.

## Data

New file `data/viewers.json`, managed by `backend/viewers/ViewersManager.js`
(same atomic tmp-file + rename pattern as `FavoritesManager`):

```json
{
  "defaultViewerId": "view_abc",
  "viewers": [
    {
      "id": "view_abc",
      "name": "Default",
      "color": "#5b8def",
      "favorites": { "channels": ["…"], "groups": [{ "id": "…", "name": "…", "channels": ["…"] }] },
      "disabledGenres": [],
      "disabledLanguages": [],
      "showAdult": false
    }
  ]
}
```

- Ids are random (`view_` + base36), never reused. Names are 1–30 characters,
  trimmed, unique case-insensitively. Colors come from a fixed palette.
- The default viewer is what any request without a (valid) viewer gets. When the
  default is deleted, the first remaining viewer becomes the default. The last
  viewer cannot be deleted.
- Favorites operations (add/remove channel, groups, legacy id migration) move
  from `FavoritesManager` into per-viewer methods; `FavoritesManager`'s file
  logic is reused for the migration only.

### Migration (first start after upgrade)

If `viewers.json` does not exist, create it with one viewer **"Default"**:

- `favorites` ← the current `data/favorites.json` (or empty),
- `showAdult` ← the saved `show_adult` setting,
- `disabledGenres` / `disabledLanguages` ← the active portal profile's values
  (or empty).

The old files and fields are left in place (not deleted), so downgrading still
works; they are simply no longer read. Migration runs once: an existing
`viewers.json` is never rewritten by it.

After migration, portal profiles hold connection details only: the profile
editor no longer shows genre/language filters, and `show_adult` leaves the
shared settings.

## Knowing which viewer is asking

`backend/lib/viewerContext.js`: an Express middleware that resolves the viewer
for each request and stores it in an `AsyncLocalStorage`, so code that has no
`req` (the shared catalog in `lib/catalog.js`, `appState.getExportFilter`,
`appState.getShowAdult`) reads the current viewer without threading it through
every call.

Resolution order, first match wins:

1. `X-Viewer` header (the website sends this on every API call),
2. `?viewer=<id>` query parameter (playlist / guide links),
3. a `/v/<id>/` path segment (Stremio addon links — Stremio appends paths to the
   manifest URL, so the viewer must be in the path); the segment is stripped
   before routing, like the access prefix,
4. the Xtream `username` when it matches a viewer's name or id (case-insensitive),
5. otherwise the default viewer.

A request naming no viewer gets the default one, so old links and the Android
app keep working. A viewer that was deleted is never swapped for the default
(that could show someone else's channels, adult ones included): a link naming
it (`?viewer=`, `/v/`) is refused with 404, and the website's `X-Viewer` gets
409 `viewerGone` from the viewer-data routes so it asks who is watching.
(Revised after the code review, 2026-10-09.)

What follows the viewer:

- `/api/favorites/*` — the viewer's favorites.
- `appState.getExportFilter()` / `getShowAdult()` / hidden languages — the
  viewer's filters. This covers M3U, XMLTV, XSPF, the Xtream API, the Stremio
  addon, and VOD category filtering (`routes/vod.js`).
- The website's channel list, guide and VOD pages already filter client-side;
  they get the values from the current viewer instead of the portal profile.
- Caches keyed by the export filter's `key` already change with the filter, so
  two viewers never share a filtered cache entry.

## API

- `GET /api/viewers` → `{ viewers: [{ id, name, color }], defaultViewerId }`
- `POST /api/viewers` `{ name, color? }` → the new viewer (empty favorites,
  nothing hidden, adult off)
- `PUT /api/viewers/:id` `{ name?, color? }`
- `DELETE /api/viewers/:id` (409 if it is the last one)
- `GET /api/viewers/me` → the current viewer, with its filters
- `PUT /api/viewers/me/filters` `{ disabledGenres?, disabledLanguages?, showAdult? }`

All are behind the existing access gate at the full-access level (the
playback-only share token cannot reach them), like `/api/settings` and
`/api/profiles`.

## Website

- `frontend/src/lib/viewer.js` keeps the chosen viewer id in `localStorage`
  (wrapped in try/catch) and adds the `X-Viewer` header in `stalkerApi.js`.
- **Who's watching?** (`ViewerPicker`): shown full-screen when this device has
  no valid viewer saved and more than one viewer exists (with exactly one viewer
  it is chosen silently, so single-person setups never see the picker). Tiles
  show a colored circle with the initial and the name; a "+ Add viewer" tile
  creates one inline. Works with a TV remote (arrow keys, Enter) like the rest
  of the app.
- **Sidebar footer:** the current viewer's circle and name above Settings;
  clicking it opens the picker. Collapsed sidebar shows just the circle.
- **Switching viewer** reloads the app's viewer-scoped state (favorites,
  filters) without a full page reload.
- **Settings:**
  - new **Viewers** section: list with rename, recolor, delete, add.
  - genre filters, language filters and Show Adult Content move into a
    **"My channels (‹name›)"** section that edits the current viewer.
  - the playlist / XMLTV / XSPF / Stremio / Xtream links shown in Settings
    include the current viewer (Xtream: the username field shows the viewer's
    name).
  - every other setting is unchanged and shared.

## Error handling

- A link naming a deleted viewer → 404; the website's deleted viewer → 409
  `viewerGone` and the picker. No viewer named → the default viewer.
- A viewer deleted while a device still has it saved → that device's next
  request gets the default viewer from the server; the website notices the
  saved id is no longer listed and shows the picker.
- Invalid names/colors → 400 with a message the Settings page shows.
- A failed write of `viewers.json` is logged as an error and the API returns
  500, so the UI does not show a change that was not saved.

## Testing

Backend (node test runner, like the existing tests):

- `ViewersManager`: create/rename/delete rules, unique names, last-viewer
  guard, default reassignment, per-viewer favorites ops.
- Migration: from favorites.json + show_adult + active profile filters; second
  start is a no-op; missing old files give an empty Default viewer.
- `viewerContext`: each resolution source, precedence, unknown id → default,
  `/v/<id>/` stripping.
- Routes: two viewers' favorites stay separate; M3U, Xtream and Stremio
  listings follow the viewer's filters; no viewer → default.

Frontend: lint and build; manual browser check of the picker, switching,
per-viewer favorites and filters, and the links shown in Settings.

## Out of scope

- PINs or any per-viewer access control.
- A viewer picker in the Android app.
- Per-viewer copies of any other setting.
- Running more than one portal connection at once.
