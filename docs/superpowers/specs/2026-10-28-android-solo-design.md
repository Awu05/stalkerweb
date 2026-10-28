# StalkerWeb Solo: the all-in-one Android app

## Why

People with their own IPTV subscription should be able to use StalkerWeb on
their own phone or TV without anyone hosting a server for them. The owner
doesn't want to host other people's IPTV: their portal, streams and viewing
must never touch the owner's server.

The owner also wants to edit things once. The screens are shared with the
current Android app, and the logic is shared with the StalkerWeb server, so a
UI change or a server fix lands in both.

## What it is

A second build of the existing Android app (`android/`), for phones and TVs,
that runs **its own private copy of the StalkerWeb server (`backend/`) on the
device**, using nodejs-mobile. The shared Compose screens talk to that local
server through the same API they use with a real server.

- **Same screens:** the screens come from the same source as the current app.
  The differences are build-level switches, never a forked copy of a screen.
- **Same server:** the server code runs unchanged inside the app, apart from
  configuration and the additions below, which go into `backend/` and work
  for the Docker server too.

## Goals

- **Everything the web app does, for one person:**
  - live TV, the guide and favorites;
  - movies and series with resume, My List and Recently watched, filters,
    and episodes with next/previous;
  - subtitles: Wyzie with the person's own key, shown masked (`****`) like
    today, plus OpenSubtitles with their own login;
  - skip intro and credits (IntroDB);
  - stream stats and settings;
  - device ID sources and the required fields.
- **The live buffer and the restart smoother** run on the device. They're the
  fix for the 4K stutter, and the owner calls them important.
- **Casting to a Chromecast** works, including channels that send raw MPEG-TS
  (see "Casting").
- **Downloads go to the device's Downloads folder**, where the person can find
  them and copy them out (see "Downloads").
- **Installs alongside the server-backed app**, under its own name
  ("StalkerWeb Solo"), with its own update check from the same GitHub
  releases.
- **First launch goes straight to "add your portal".** There's no server
  address to enter.

## Non-goals

- Several viewers, "Who's watching?", logins and access control: it's one
  person on one device. The server's default viewer is used and the viewer UI
  is hidden.
- Syncing between devices. Data lives on the device, and uninstalling the app
  erases it.
- Serving other apps: M3U and XMLTV links, the Xtream API, the Stremio add-on,
  export filters and the logs monitor.
- The web UI. The frontend isn't bundled.

## Anti-goals (a failure even if it works)

- A second copy of a screen, or of server logic, written for Solo. That
  defeats the point.
- Anything of the person's sent to the owner's server or any server of ours,
  including portal details, keys, history and streams.
- An update of either app that picks up the other app's APK.
- A local server that other apps on the device, or other devices on the
  network, can use to reach the portal, the settings or the keys.

## Decisions made

- **Embedded runtime: nodejs-mobile, Node 18** (v18.20.4 is the newest).
  Node 18 gets no security fixes any more. The owner accepted this on
  condition that the runtime stays swappable: starting and stopping Node sits
  behind one small interface, so a newer Node for Android (for example one
  built with Node's own `android-configure`) can replace it later without
  other changes.
- **The server stays compatible with Node 18.** CI runs the backend tests on
  Node 18 as well as 20. `axios-cookiejar-support` 7 needs Node 22, so it's
  pinned to a version that supports 18 or replaced. That's the builder's
  call.
- **Casting uses a JavaScript HLS segmenter, no ffmpeg.**
  - The server's cast path (`stalker/CastHls.js`) runs ffmpeg with `-c copy`,
    which only cuts the stream into 4-second pieces. A segmenter in
    `backend/` does the same: it cuts a raw MPEG-TS stream at video keyframes
    (random-access points), starts each piece with the PAT/PMT, and keeps a
    live playlist.
  - It's used by Solo and by the Docker server. The Docker image keeps ffmpeg
    for its other jobs.
  - Channels whose codecs the Chromecast can't decode, such as MPEG-2, still
    can't be cast. That's unchanged from today.
  - Cast streams go through the live buffer, as today.
- **Downloads without ffmpeg:**
  - A title the portal serves as a file (mp4, mkv) is saved as it is.
  - A title it serves as HLS is joined into one `.ts` file. TS pieces join
    into a valid file, so nothing is converted.
  - Finished files are published to the public Downloads folder through
    MediaStore (Android 10+), so no storage permission is needed.
  - On Android 8 and 9 (minSdk is 26), the builder picks the closest
    equivalent.
  - The Docker server keeps its ffmpeg remux to mp4.
- **The browser transcode isn't needed.** The server uses ffmpeg to convert
  MPEG-2 video and AC-3 audio for browsers (`FfmpegService`). The Android
  player decodes those itself, so in Solo that path stays off; the server
  already checks whether ffmpeg is there. Every ffmpeg-dependent feature has
  to fail cleanly, or offer an ffmpeg-free path, when ffmpeg is missing.
- **Build layout:**
  - A second Gradle flavor dimension next to the existing `form`
    (mobile/tv), for example `backend` with `remote` and `solo`. That gives
    four APKs.
  - Solo gets its own application ID, so it installs alongside the
    server-backed app.
- **APK names must not match the old apps' update rule.** Installed apps pick
  their APK with `-(tv|mobile)[-.]` (`UpdateRules.kt`), so a name like
  `stalkerweb-solo-tv-v…` would be picked up by the existing TV app. Solo's
  APKs need names that rule doesn't match, for example `stalkerweb-solo_tv-v…`
  and `stalkerweb-solo_mobile-v…`. The new rule in Solo must match only its
  own APKs, and the remote apps' rule must keep ignoring them; tests cover
  both.
- **Versioning:** the same version number and the same release as the server
  (`vX.Y.Z`). The release workflow builds all four APKs.

## Constraints

- **Lock down the local server:**
  - It listens on `127.0.0.1` only.
  - A random access key made on first launch and kept in the app's private
    storage is passed as `ACCESS_KEY`. The app sends it the way it already
    does (an `Authorization` header), so other apps on the device get
    nothing.
  - Casting is the one exception, because the Chromecast must fetch the
    stream over the home network. Only the cast stream (playlist and pieces)
    is reachable from the LAN, under an unguessable per-session token. Every
    other route stays on localhost.
- **Server data** goes in the app's private storage (`DATA_DIR`), so it's
  removed on uninstall and isn't readable by other apps.
- **Lifecycle:**
  - Node starts with the app, and the screens wait until the server answers.
  - It's kept alive with a foreground service while something needs it
    (playing, casting, downloading, the live buffer). Otherwise Android may
    stop it.
  - If Android kills it, it starts again by itself, without the person
    noticing beyond a short wait.
- **CPU architectures:** ship at least `arm64-v8a` (the Shield and modern
  phones) and `armeabi-v7a` (older TV sticks).
- **16 KB page-size devices** (some Android 15+ devices): check that the
  nodejs-mobile library loads there. If it doesn't, write it down as a known
  limit instead of blocking.
- **Size:** Solo is expected to be about 30–50 MB larger than the remote app.
  That's accepted.
- **No real identifiers anywhere.** Tests, fixtures and PR text never contain
  the owner's real MAC, serial, UID, device IDs or portal. Use made-up
  values (for example MAC `00:1A:79:12:34:56`). TS recordings used as test
  fixtures must come from a public or synthetic source, not the owner's
  portal.

## What changes in the shared app (by switch, not by copy)

- **Setup:** no server address. First launch opens the portal profile editor
  (the existing one, with its required fields and device ID sources).
- **Hidden in Solo:** viewers and "Who's watching?", server and access-key
  settings, and the export and links settings. Everything else is identical.
- **Settings → App:** the update check looks for Solo's own APKs.
- **Downloads:** says where files went ("saved to Downloads").

## Left to the builder

- Module and package layout for the Node bridge and the runtime interface.
- How the server code and its `node_modules` are packed into the APK, and
  how they're updated between versions.
- Choice of foreground-service triggers, and how start-up waiting is shown.
- Segmenter internals: TS parsing, keyframe detection, piece length,
  playlist window, and recovering after a source restart.
- Whether the server stores `.ts` or `.mp4` downloads in Solo.
- Order of the work. A sensible order:
  1. Flavors, with the embedded server running and the app working against
     it.
  2. Solo setup and hiding the multi-user parts.
  3. The segmenter and casting.
  4. Downloads to the Downloads folder.
  5. Release packaging.

## How we'll know it works

- A fresh Solo install on a phone and on the Shield: add a portal, then watch
  a live channel, a 4K channel (buffer on), a movie and an episode with
  resume, subtitles and skip intro.
- Cast a channel that sends raw TS, and cast a VOD.
- Download a file-served title and an HLS title, and find both in Downloads.
- The server-backed app installed beside it keeps working, and each app
  updates only to its own APK.
- Backend tests pass on Node 18 and 20. The segmenter has tests against
  recorded TS samples, including a source restart. Android unit tests cover
  the APK rule and the Solo switches.
- Nothing the person does in Solo reaches any server except their portal and
  the subtitle and skip services they use.
