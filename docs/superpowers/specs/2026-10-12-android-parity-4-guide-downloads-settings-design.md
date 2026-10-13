# Android parity, part 4: Guide, Downloads and Settings

Date: 2026-10-12
Status: design approved
Builds on parts 1–3. The shell already has Guide, Downloads and Settings sections. Guide and Downloads are placeholders, and Settings only links to the Setup and Portal screens.

## Goals

- **Guide**, as on the web (`EpgGridPage.jsx`, `GuideListView.jsx`):
  - a grid on TV and wide screens;
  - a list on phones;
  - genre and favorites filters;
  - programme details with Watch;
  - local "Remind me".
- **Downloads**, as on the web (`DownloadsPage.jsx`):
  - server downloads with live progress, and Cancel / Delete;
  - download buttons back in VOD: posters, the player, and per episode and per season in the seasons pop-up.
- **Settings**, with the web's tabs: Viewers, Connection, Links, Playback, Logos.

## Non-goals

- STBEmu backup import and export. It involves files, so it stays on the web.
- Editing the device's STB identity. It's shown read-only, and editing stays on the web.

## Design

### 1. Guide (`ui/guide`)

**Data:**
- `GET /api/epg?period=24` returns `{ period, channelCount, epg: { uniqueId: [Event] } }`, where an event is `{ id, title, startTime, endTime, description }` in seconds.
- `GuideRepository` loads it (period 24 h, cached for 10 min) and joins it to the viewer's channel list from `LiveRepository.getChannels()`, which is already filtered for them. Channels without events are left out, as on the web.

**Pure helpers** (`data/repo/GuideRules.kt`, tested):
- `slotStart(now, slotMinutes = 30)` floors to the slot.
- `eventSpan(event, windowStart, windowEnd)` gives `(offsetMinutes, durationMinutes)`, clipped to the window, or null outside it.
- `eventAt(events, time)` gives the event airing then.
- `progressOf(event, now)` gives a value from 0 to 1.

**Wide layout (TV and tablets):**
- A fixed channel column, 180 dp wide (logo and name), next to a timeline that scrolls sideways. A minute is 6 dp, and the time header has 30-minute ticks.
- Each channel row has a fixed height of 64 dp. The timeline shows now − 30 min to now + 24 h.
- A vertical "now" line, and the row scrolled so that now is near the left edge.
- **Remote:**
  - Up/Down moves between rows; the rows scroll together.
  - Left/Right moves between programmes in a row.
  - OK opens details.
  - Each programme cell is a focusable `Box` sized from `eventSpan`.

**Phone layout:**
- A channel list; picking one shows its schedule for today, with the current programme highlighted and a progress bar.

**Filters:** "All", "Favorites" and the genre pills, in the same form as Channels.

**Details dialog:**
- The title, the time range, the description and the channel.
- **Watch**, when it's on now: opens the live player.
- **Remind me**, when it's in the future: toggles the reminder.

**Reminders** (`data/repo/Reminders.kt` and `ReminderReceiver`):
- Stored per device in `AppPrefs`: `[{ id, channelId, channelName, title, startTime }]`.
- Scheduled with `AlarmManager.setAndAllowWhileIdle` (inexact, but at most a few minutes late) for `startTime − 60 s`.
- The receiver posts a notification: "Starting now: <title> on <channel>". Tapping it opens the app on that channel's player through an intent extra `channelId`.
- **Permissions:** `POST_NOTIFICATIONS` is requested the first time a reminder is set (Android 13+). A reminder in the past is dropped.
- **Guide:** a bell on the programmes with a reminder.
- **Shell:** a bell button in the rail or top bar lists the reminders, each with Remove, like the web's ReminderBell.

### 2. Downloads (`ui/downloads`)

**Data:**
- `GET /api/downloads` returns `{ downloads: [Job] }`.
- `POST /api/downloads` takes `{ items: [{ videoId, cmd, series, seasonId, episodeId, title, seriesTitle }] }`.
- `DELETE /api/downloads/{id}` cancels or removes a job.
- A job is `{ id, title, seriesTitle, status (queued|downloading|done|error|canceled), bytesDownloaded, totalBytes, error, createdAt }`.

**Live progress:**
- While the Downloads screen is open, the app reads `GET /api/downloads/events`, a server-sent event stream carrying the whole list as `data: <json>`, through OkHttp with a streaming body.
- It parses the `data:` lines with a pure `parseSseData(line)` that's tested.
- When the stream drops, it falls back to polling `GET /api/downloads` every 3 s.

**Screen:**
- One row per job: the title (with the series title if there is one), the status, and a determinate progress bar when `totalBytes > 0`, otherwise an indeterminate one while downloading.
- The size uses `formatBytes`, which is pure and tested.
- Cancel while queued or downloading; Delete otherwise.
- An empty state.

**VOD:**
- `PosterTile.onDownload` is passed for movies: the corner button on touch, and "Download to server" in a long-press-free way through the player's top bar on TV.
- The seasons pop-up gets a download button on each episode row and "Download season".
- A toast confirms each download with "Queued …", as on the web.

### 3. Settings (`ui/settings`): tabs as on the web

A tab row (`SettingsTabs`): Viewers · Connection · Links · Playback · Logos. The last tab used is remembered (`AppPrefs.settingsTab`).

**Viewers:**
- **The list:** each viewer with their avatar and name. You can rename them, recolour them (a palette of the web's colours) and delete them. Deleting asks for confirmation, and the default viewer can't be deleted.
  - Uses `PUT /api/viewers/{id}` with `{ name?, color? }` and `DELETE /api/viewers/{id}`.
  - Deleting the device's own viewer opens the picker.
- **Add viewer.**
- **The current viewer's filters** (`PUT /api/viewers/me/filters` with `{ disabledGenres, disabledVodCategories, showAdult }`):
  - **Live TV:** a checklist of channel genres (`/api/channels/groups/all`) with All/None.
  - **Movies & Series:** a checklist of the portal's own categories (`/api/vod/categories?type=…&all=1`).
  - **Show adult content.**
  - Saving reloads the viewer, and the Live TV and VOD sections reload too, through `ViewerRepository.changes`.
- **List building** (`settingsFilterLists`, tested): checked means shown, and the saved list is the unchecked names.

**Connection:**
- The server address and access key: today's Setup form, embedded.
- **Saved IPTV connections** (`/api/profiles`): connect or switch (today's Portal actions), and disconnect or reconnect.
  - Add or edit a connection's name, portal, MAC, timezone, language, login, password, token, serial, device IDs and signature. Delete asks for confirmation.
  - Uses `POST /api/profiles`, `PUT /api/profiles/{id}` and `DELETE /api/profiles/{id}`.
- **Device profile:** the STB identity (model, firmware) shown read-only from `/api/settings`.

**Links:** this viewer's links, built as the web builds them.
- **Built from:**
  - the server address;
  - `/k/<share token>` when an access key is set (from `/api/settings`);
  - the viewer query `?viewer=<id>` or path `/v/<id>`.
- **The links:**
  - Xtream server
  - Xtream password (with a key: the share token)
  - Stremio addon (`/stremio/manifest.json`, https when `https_port` is set)
  - M3U (`/api/m3u`)
  - VLC (`/api/xspf`)
  - XMLTV (`/api/xmltv`)
- **Actions:** Copy on each, and Share on phones.
- **`linksFor(base, shareToken, viewerId, httpsPort)`** is pure and tested.

**Playback** (`GET` and `POST /api/settings`, shared by every viewer): toggles and pickers for:
- VOD on/off and guide on/off;
- live buffer seconds: 0 (off), 5, 10, 15, 30, 60;
- idle disconnect minutes: 0 (never), 15, 30, 60, 120, 240;
- the download folder (a text field).

Saving shows the server's error message, if any.

**Logos** (`/api/logos*`):
- **Database:** the counts, plus a "Refresh logo database" button.
- **Overrides** (name → URL): a list with Remove, and Add (name and URL).
- **Strip words:** a list with Remove, and Add.

### 4. Remote and touch

- Every control is focusable and reachable with the D-pad.
- Text fields don't take focus until they're selected.
- Tabs are `Pill`s.

## Testing

JVM tests for:
- `GuideRules`
- `parseSseData`
- `formatBytes`
- `linksFor`
- `settingsFilterLists`
- the reminder rules: due time, dropping past ones, unique ids

The UI is covered by the shared device checklist.

## Rollout

- Branch `feat/android-guide-settings`, stacked on `feat/android-live`, with a draft PR into main.
- After part 4, the device checklist covers all four parts.
- Release only once you've tested on your devices.
