# StalkerWeb

Self-hosted IPTV web app that replicates [Kodi's pvr.stalker](https://github.com/AlexELEC/pvr.stalker) functionality in a browser — no Kodi required.

[![Release](https://github.com/rangoDJ/stalkerweb/actions/workflows/release.yml/badge.svg)](https://github.com/rangoDJ/stalkerweb/actions/workflows/release.yml)
[![CI](https://github.com/rangoDJ/stalkerweb/actions/workflows/ci.yml/badge.svg)](https://github.com/rangoDJ/stalkerweb/actions/workflows/ci.yml)

---

## Features

- 🔌 **Full Stalker Middleware protocol** — handshake, token auth, keep-alive watchdog, idle session timeout that auto-renews while playback is streaming.
- 📺 **Dynamic Channel Grid** — with multi-line genre filtering, search, and keyboard number-jump.
- ❤️ **Favorites** — star channels, organize into custom drag-and-drop groups, with inline group editor.
- 📅 **EPG Guide** — with scrollable timeline, configurable lookahead (6h–48h), and built-in player integration.
- 🔞 **Parental Lock** — toggleable filtering for adult content across all pages.
- 📱 **Android & Android TV Apps** — companion Kotlin/Compose app, built for phones and for leanback TV, with auto-update and in-app crash reports (API 26+).
- ▶️ **HLS.js Video Player** — HLS playback with auto-recovery, native fallback for MP4/TS, fullscreen, volume, and keyboard shortcuts (`Space` play/pause, `F` fullscreen, `M` mute, arrow keys channel surf).
- 🖼️ **Logo Matching** — automatic channel logo lookup via `iptv-org` with manual override support.
- 🔁 **STBEmu Backup Export/Import** — export a profile as a ready-to-import STBEmu JSON, or import an STBEmu backup file (including multi-profile files, with a picker) straight into StalkerWeb.
- 🎬 **VOD & Series** — browse categories, seasons/episodes, search, favorites, and resumable "Continue Watching" progress.
- 📥 **Server-side Downloads** — save VOD titles to disk, with HLS-to-MP4 remuxing via ffmpeg.
- 💾 **Session Persistence** — auto-reconnects to portal on container restart; saved tokens per portal.
- 👤 **Multi-Profile** — save multiple portal connections and switch between them, each with its own genre filters.
- 🌐 **Multi-platform Docker** — `amd64` + `arm64` builds.
- 🛡️ **Security** — rate-limited auth endpoints, SSRF-guarded HLS proxy, input validation on all critical routes, structured logging.
- ✅ **Code Quality** — ESLint 9 flat config (backend + frontend), Prettier, 21 automated tests in CI.

## Quick Start (Docker)

```yaml
# docker-compose.yml
services:
  stalkerweb:
    image: ghcr.io/rangodj/stalkerweb:latest
    container_name: stalkerweb
    restart: unless-stopped
    ports:
      - "8983:8983"
    volumes:
      - ./data:/app/data
    environment:
      - NODE_ENV=production
      # Optional: minutes of inactivity before the portal session is torn
      # down (default 30). The timer is held off while a stream is playing,
      # so this is only the grace window after the last viewer disconnects.
      # This is the default; Settings → App Preferences can change it (or
      # turn it off) at runtime, and a value saved there takes precedence.
      # - IDLE_TIMEOUT_MINUTES=30
```

```bash
docker-compose up -d
```

Then open **http://localhost:8983** and use the **Setup** page to add a portal profile (URL, MAC, and optional advanced fields) and click **Connect**.

The container includes:
- **HEALTHCHECK** — pings `/api/health` every 30s; Docker marks unhealthy after 3 failures.
- **Graceful shutdown** — on `SIGTERM`, the portal session is destroyed before exit.

## Android App

Every release ships two APKs — one for phones/tablets and one for Android TV. They
share a single Kotlin/Compose codebase and differ only in launcher, input model and
a few platform features. Their application ids differ
(`com.stalkerweb.android` and `com.stalkerweb.android.tv`), so both can be installed
side by side on the same device.

- **Installation** — download `stalkerweb-mobile-<version>.apk` or
  `stalkerweb-tv-<version>.apk` from the [Releases](https://github.com/rangoDJ/stalkerweb/releases)
  page. Requires Android 8.0 (API 26) or newer.
- **Setup** — point the app at your StalkerWeb server address; it can be changed
  later from the settings button on the channel list.
- **Portal connection** — portals are set up in the web UI. The app connects using
  the saved profiles it reads back from the server, with no manual portal/MAC entry
  and no portal credentials stored on the device.
- **Live TV** — channel list with search, genre chips, favorites, now/next EPG on
  each row, and a recently-watched row.
- **VOD & Series** — categories, search, seasons and episodes, and a prompt to play
  the next episode when one finishes.
- **Per-channel stream override** — pin a specific stream URL for a channel that
  won't play through the proxy.
- **Sleep timer**.
- **Genre filtering** — the active profile's disabled genres are applied to the
  channel and group lists, matching the web UI.
- **Auto-update** — checks GitHub Releases and installs the new APK in place.
- **Crash reports** — an uncaught crash is recorded and shown on the next launch
  with copy/share, so a failure on a TV across the room can be reported without
  needing `adb`.

**Phone and tablet only:** Google Cast and picture-in-picture.
**TV only:** leanback launcher entry, D-pad focus handling and overscan-safe padding.

## Security

- **Rate Limiting** — Auth endpoints are rate-limited to prevent brute-force attacks.
- **SSRF Protection** — The HLS proxy validates all proxied URLs match the connected portal domain.
- **Input Validation** — Express-validator middleware sanitizes channel IDs, URLs, and auth fields on all critical routes.
- **Structured Logging** — All backend operations log via a structured logger with severity levels, redacted tokens.
- **Container HEALTHCHECK** — Docker monitors the service health and restarts on failure.

---

## HLS Proxy

StalkerWeb includes a built-in HLS proxy that forwards stream requests to the portal on behalf of external clients (Jellyfin, VLC, etc.). All proxy URLs are SSRF-guarded against the connected portal domain.

| Endpoint | Description |
|---|---|
| `GET /proxy/stream/:channelId` | Proxy the master HLS playlist for a channel |
| `GET /proxy/hls?url=<encoded>` | Proxy an HLS sub-playlist |
| `GET /proxy/hls/seg/<encoded>.ts` | Proxy an HLS segment |

While any of these connections is open, the backend renews the idle-disconnect
timer on a 60-second heartbeat, so playback through **any** client (web,
Jellyfin, Kodi, VLC) keeps the portal session alive — including single,
long-lived stream pipes — and the session only tears down after the idle timeout
(Settings → App Preferences, default `IDLE_TIMEOUT_MINUTES`) once the last viewer
disconnects. Setting it to **Never** disables auto-disconnect.

---

## Live Log Monitor

The backend exposes its structured logs over HTTP so an external agent (Claude,
Antigravity, a dashboard, or plain `curl`) can watch them in real time. Every
log line is also kept in an in-memory ring buffer (last `LOG_BUFFER_SIZE` lines,
default 1000) so a fresh connection immediately gets recent history.

| Endpoint | Description |
|---|---|
| `GET /api/logs` | One-shot JSON snapshot of the buffer |
| `GET /api/logs/stream` | SSE stream — replays the buffer, then live-tails new lines |

Both accept query filters: `?level=info|warn|error|debug`, `?tag=<source>`,
`?since=<seq>` (only lines after a given sequence number), `?limit=<n>`. Each
record is `{ seq, ts, level, tag, msg }`. The SSE stream emits an `id:` per
event, so a client that drops can resume gap-free via the `Last-Event-ID`
header (or `?since=`).

**Access control** — these logs can contain the portal MAC, portal URL and
stream tokens, so the endpoint is **localhost-only by default**: it accepts
requests only from the same host/container unless `LOG_MONITOR_TOKEN` is set.
With a token, any source IP may connect by sending it as `?token=<token>` or
`Authorization: Bearer <token>`.

```bash
# Tail the live stream from the same host:
curl -N http://localhost:8983/api/logs/stream

# Only errors, with a token, from a remote agent:
curl -N -H "Authorization: Bearer $LOG_MONITOR_TOKEN" \
  "http://your-host:8983/api/logs/stream?level=error"
```

---

## Jellyfin Integration

StalkerWeb exposes an M3U playlist and an XMLTV guide feed that Jellyfin can consume directly.

### 1. Add M3U Tuner
Set the M3U URL to: `http://your-host:8983/api/m3u`

### 2. Add XMLTV Guide
Set the XMLTV URL to: `http://your-host:8983/api/xmltv`

The playlist and guide only include channels you haven't hidden: genres and
languages turned off under Settings → Genre Filters are left out, as are adult
channels unless Show Adult Content is on. Add `?all=1` to either URL to include
every channel.

Channels the portal has no guide data for get 6-hour placeholder blocks so they
still show in the guide. Add `?filler=none` to leave them out for a smaller,
faster import. The feed is gzip-compressed for clients that accept it and cached
between refreshes.

> **Upgrading from a build before channel ids moved to portal ids:** `tvg-id`
> values in the M3U changed, so Jellyfin (or Kodi) needs one guide refresh /
> tuner re-scan to re-map its channels. Stream URLs minted by older builds still
> resolve — the backend accepts the old ids — so existing recordings and
> bookmarks keep working. Favorites, and the Android app's stream overrides and
> watch history, migrate themselves on first run.

---

## Building from Source

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Development
cd frontend && npm run dev     # UI at :5173
cd backend  && node server.js  # API at :8983

# Production build
cd frontend && npm run build
cd ..       && node backend/server.js
```

## License

MIT
