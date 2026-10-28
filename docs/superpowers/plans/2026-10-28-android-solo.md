# StalkerWeb Solo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a second Android build ("StalkerWeb Solo", phone and TV) that runs the real StalkerWeb server on the device through nodejs-mobile, and shares every screen with the server-backed app.

**Architecture:**
- The server (`backend/`) gains a Solo mode, an ffmpeg-free TS segmenter for casting, and an ffmpeg-free HLS download. All of these also work in Docker.
- The Android app gains a second flavor dimension, `backend` = `remote` | `solo`. Solo-only code lives in `src/solo/`. It starts Node in its own process, points the shared app at `http://127.0.0.1:<port>` with a random access key, and adds the few Solo behaviours behind `BuildConfig.IS_SOLO`.

**Tech Stack:**
- Server: Node 18/20, Express 5, vitest.
- Android: Kotlin, Jetpack Compose, Media3, Cast SDK, NDK/CMake (JNI to nodejs-mobile `libnode.so` v18.20.4).
- CI: GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-28-android-solo-design.md`

## Global Constraints

- Embedded runtime: nodejs-mobile **v18.20.4**, behind one interface (`NodeRuntime`) so it can be swapped later.
- The server must run on **Node 18 and 20**. CI runs the backend tests on both.
- Local server: listens on **`127.0.0.1`** only, with a random **`ACCESS_KEY`** made on first launch. Only the cast stream (`/k/<shareToken>/proxy/…`) is reachable from the LAN.
- Server data lives in the app's private storage (`DATA_DIR`).
- Solo app IDs: `com.stalkerweb.android.solo` (phone) and `com.stalkerweb.android.tv.solo` (TV). App name: **"StalkerWeb Solo"**.
- APK names: `stalkerweb-solo_mobile-vX.Y.Z.apk` and `stalkerweb-solo_tv-vX.Y.Z.apk`. They must **not** match the remote apps' rule `-(tv|mobile)[-.]`.
- ABIs shipped in Solo: `arm64-v8a`, `armeabi-v7a`.
- The remote APKs must not contain `libnode.so` or the server bundle.
- No ffmpeg in Solo. Every ffmpeg-dependent server feature fails cleanly, or uses its ffmpeg-free path, when ffmpeg is missing.
- Downloads land in the public **Downloads** folder (subfolder `StalkerWeb`) through MediaStore on Android 10+. HLS titles become one `.ts` file.
- No real identifiers in tests, fixtures, scripts or PR text. Use made-up values (MAC `00:1A:79:12:34:56`, portal `http://portal.example/c/`). TS fixtures are synthetic, made by a test helper.
- Comment and naming style follows the surrounding code (plain-language comments, as in `backend/lib/liveBuffer.js`).
- No local JDK: Android compiles and unit tests run in CI (`gh workflow run ci.yml --ref feat/android-solo`).

## Review Focus

1. **A source restart while casting** (a raw-TS pipe that ends and reconnects, or an HLS source that jumps): the TV keeps playing past a discontinuity instead of stopping. Test in Task 3.
2. **The Wi-Fi address changes, or there is none** (mobile data only) when casting starts: the cast link uses the current LAN address, or the app says casting needs Wi-Fi. Never a `127.0.0.1` link. Tests in Tasks 5 and 8.
3. **Android kills the Node process mid-use** (low memory, swipe-away): the server comes back on the same port and key, and the next request succeeds after a short wait. It must not land on the Setup screen. Test in Task 7.
4. **An HLS movie with an encryption key, or a master playlist with several variants**: an encrypted one fails with a clear message, and the highest-bandwidth variant is downloaded. Test in Task 4.
5. **Removing a finished download after it was moved to Downloads** (the private file is gone): the remove succeeds, and the copy in Downloads is left alone. Test in Task 4.

---

### Task 1: The server runs on Node 18

**Files:**
- Modify: `backend/package.json` (`engines.node` → `">=18"`, cookie-jar dependency)
- Modify: `backend/stalker/StalkerClient.js:11,42,91` (only if the cookie-jar helper is replaced)
- Create (only if replacing): `backend/lib/cookieJarAxios.js`
- Modify: `.github/workflows/ci.yml` (backend job: matrix `node-version: ['18', '20']`)
- Test: the existing backend suite, plus `backend/tests/cookie-jar.test.js` if the helper is replaced

**Interfaces:**
- Produces: a backend that runs on Node 18. Nothing else changes.

- [ ] **Step 1: Run the backend suite on Node 18 to see what breaks**

Run: `cd backend && npx -y node@18 node_modules/vitest/vitest.mjs run 2>&1 | tail -20`
Expected: FAIL or engine warnings. At least `axios-cookiejar-support@7` declares `node >=22`.

- [ ] **Step 2: Fix the cookie jar**

Use the newest `axios-cookiejar-support` major whose `engines` allows 18 and that works with `tough-cookie@6`. Check with `npm view axios-cookiejar-support@<major> engines peerDependencies`.

If none does, replace it with `lib/cookieJarAxios.js`:
- `withCookieJar(instance: AxiosInstance, jar: CookieJar): AxiosInstance`
- Its request interceptor sets `Cookie` from `jar.getCookieStringSync(url)`.
- Its response interceptor stores every `set-cookie` with `jar.setCookieSync(c, url, { ignoreError: true })`, including on redirects (`maxRedirects` stays 10, so cookies are set per hop through `beforeRedirect`).

Test it with these cases in `tests/cookie-jar.test.js`:
- `'sends the cookies seeded into the jar'`
- `'keeps cookies the portal sets, across a redirect'`

- [ ] **Step 3: Set `engines.node` to `">=18"` and add the Node 18/20 matrix to the backend job in `ci.yml`**

- [ ] **Step 4: Run the suite on both**

Run: `cd backend && npx -y node@18 node_modules/vitest/vitest.mjs run && npx vitest run`
Expected: both PASS with the same counts as before, plus any new tests.

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/stalker/StalkerClient.js backend/lib backend/tests .github/workflows/ci.yml
git commit -m "chore(server): runs on Node 18 too (the all-in-one app's runtime) — tested on 18 and 20"
```

---

### Task 2: An MPEG-TS segmenter (no ffmpeg)

**Files:**
- Create: `backend/stalker/TsSegmenter.js`
- Create: `backend/tests/helpers/makeTs.js` (synthetic TS: PAT, PMT, video PES with PTS, random-access flag or IDR NAL, audio PES)
- Test: `backend/tests/ts-segmenter.test.js`

**Interfaces:**
- Produces:
  - `class TsSegmenter({ targetSeconds = 4, windowSize = 10, now = Date.now })`
  - `push(chunk: Buffer): void` takes bytes in any split, not aligned to 188.
  - `discontinuity(): void` means the next piece starts after a break.
  - `playlist(): string | null` is a live media playlist, or null until the first piece is ready.
  - `segment(name: string): Buffer | null`
  - `get codecs(): { videoType: number | null, audioType: number | null }`, the PMT stream types.
  - Pieces are named `seg<seq>.ts`, with `seq` counting up from 0 per segmenter.
- `makeTs({ seconds, fps = 25, keyEvery = 2, pcrPid, video = 0x1b, audio = 0x0f }): Buffer` (test helper).

- [ ] **Step 1: Write the failing tests**

```js
it('cuts at keyframes into ~4 s pieces, each starting with PAT and PMT', () => {
  const s = new TsSegmenter()
  s.push(makeTs({ seconds: 13, keyEvery: 2 }))
  const names = [...s.playlist().matchAll(/^(seg\d+\.ts)$/gm)].map((m) => m[1])
  expect(names).toEqual(['seg0.ts', 'seg1.ts', 'seg2.ts'])   // the last, open piece isn't listed
  for (const n of names) {
    const b = s.segment(n)
    expect(b[0]).toBe(0x47); expect(pidOf(b, 0)).toBe(0); expect(pidOf(b, 188)).toBe(PMT_PID)
    expect(startsWithKeyframe(b)).toBe(true)
  }
  expect(s.playlist()).toMatch(/#EXTINF:4\.0{0,3}/)
})
it('takes bytes split anywhere, not on packet boundaries', () => { /* same stream pushed in 7-byte chunks → same playlist */ })
it('keeps a window of 10 pieces and drops older ones', () => { /* 60 s in → 10 listed, MEDIA-SEQUENCE advances, segment("seg0.ts") === null */ })
it('marks the piece after a break with EXT-X-DISCONTINUITY', () => { /* push, discontinuity(), push a stream whose PTS restarts at 0 → tag before that piece, no negative EXTINF */ })
it('finds keyframes in HEVC too', () => { /* video: 0x24, IRAP NAL types */ })
it('reports the stream types, for a "can\'t cast this" message', () => { /* video 0x02 (MPEG-2) → codecs.videoType === 2 */ })
it('cuts by time when a stream has no keyframe marks at all', () => { /* keyEvery: 0 → pieces still made, at ~targetSeconds */ })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/ts-segmenter.test.js`
Expected: FAIL, "Cannot find module '../stalker/TsSegmenter'".

- [ ] **Step 3: Implement `TsSegmenter` in `backend/stalker/TsSegmenter.js`**

1. Re-align on the 0x47 sync byte.
2. Read the PAT to find the PMT PID, and the PMT to find the first video PID and stream type, plus the first audio PID.
3. A packet with `payload_unit_start` on the video PID starts a PES. Read its PTS (90 kHz).
4. It is a cut point when either is true:
   - the adaptation field's `random_access_indicator` is set;
   - the PES payload holds a keyframe NAL: H.264 type 5, or HEVC types 16–21.
5. Close the open piece at the first cut point at least `targetSeconds` after its first PTS, and prepend the latest PAT and PMT packets to each new piece.
6. `#EXTINF` is the PTS difference to the next piece's start. Handle 33-bit wrap. After `discontinuity()`, or a PTS jump of more than 10 s, emit `#EXT-X-DISCONTINUITY` and take the duration from the packets' arrival time instead.
7. Playlist header: `#EXT-X-VERSION:3`, `#EXT-X-TARGETDURATION` (the ceiling of the largest EXTINF), `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-INDEPENDENT-SEGMENTS`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/ts-segmenter.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/stalker/TsSegmenter.js backend/tests/helpers/makeTs.js backend/tests/ts-segmenter.test.js
git commit -m "feat(server): an MPEG-TS segmenter — cuts a live stream into HLS pieces at keyframes, no ffmpeg"
```

---

### Task 3: Casting on the segmenter

**Files:**
- Modify: `backend/stalker/CastHls.js` (ffmpeg process → segmenter fed by a reader; sessions in memory, no folders)
- Create: `backend/stalker/selfStreamReader.js`
- Modify: `backend/routes/proxy.js:1015-1040` (serve playlist and segments from memory; drop the "needs FFmpeg" 415)
- Modify: `backend/server.js:355-366` (CastHls options: no `available`, no `spawn`)
- Test: `backend/tests/cast.test.js` (rewrite the ffmpeg-spawn cases), `backend/tests/self-stream-reader.test.js`

**Interfaces:**
- Consumes: `TsSegmenter` (Task 2).
- Produces:
  - `readSelfStream(url: string, { onData(buf), onBreak(), signal, userAgent, fetchImpl = fetch }): Promise<void>`. For a raw-TS response it streams the body. For an HLS playlist it polls it, fetches each new segment once and in order, and follows a master playlist to its first variant. It resolves when `signal` aborts. A source that ends or fails calls `onBreak()` and reconnects after `min(2^n × 250 ms, 5 s)`.
  - `CastHls` keeps `constructor({ inputUrlFor, userAgent, idleMs, maxSessions, now, reader = readSelfStream })`.
  - `CastHls` methods:
    - `playlist(id): Promise<string>`: the playlist text, waiting at most 15 s for the first piece.
    - `segment(id, name): Buffer | null`
    - `stop(id, why)`
    - `available(): true`
  - `CastHls.codecsOf(id): { videoType, audioType } | null` for the log line.

- [ ] **Step 1: Write the failing tests**

`self-stream-reader.test.js`:
- `'streams a raw TS body'`
- `'follows a live HLS playlist, each segment once and in order'`
- `'calls onBreak and reconnects when the source ends'`
- `'stops when aborted'`

Use a fake `fetchImpl` returning `Response` objects.

`cast.test.js`:
- `'serves a playlist and its pieces for a channel while it is cast'`
- `'keeps the TV playing across a source restart (EXT-X-DISCONTINUITY, pieces keep coming)'`
- `'stops a session no one asked for in idleMs'`
- `'starts no more than maxSessions'`

Use a fake `reader` that feeds `makeTs` output.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/cast.test.js tests/self-stream-reader.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `selfStreamReader.js`, then switch `CastHls` to it**

Keep the idle sweep and the session limit. Change the proxy routes to:
- `res.type('application/vnd.apple.mpegurl').send(text)` for the playlist;
- `res.type('video/mp2t').send(buf)` for a segment, or 404.

`server.js` no longer passes `available`.

- [ ] **Step 4: Run the whole backend suite**

Run: `cd backend && npx vitest run`
Expected: PASS. Remove `ffmpeg-through-proxy` tests only where they test the cast path, and keep the ones for `FfmpegService`.

- [ ] **Step 5: Commit**

```bash
git add backend/stalker backend/routes/proxy.js backend/server.js backend/tests
git commit -m "feat(server): casting live TV without ffmpeg — the segmenter packs a channel as HLS for the TV, across source restarts"
```

---

### Task 4: HLS downloads without ffmpeg

**Files:**
- Create: `backend/downloads/hlsConcat.js`
- Modify: `backend/downloads/DownloadManager.js:120-140` (use it when `!FfmpegService.isAvailable()`, extension `ts`; include `filePath` in a finished job's JSON)
- Modify: `backend/downloads/DownloadManager.js` remove path (a missing file is not an error)
- Test: `backend/tests/hls-concat.test.js`, `backend/tests/downloads.test.js` (add cases)

**Interfaces:**
- Produces:
  - `hlsConcat(url: string, outPath: string, { signal, onBytes(n), headers, fetchImpl = fetch }): Promise<void>`
  - A finished job's JSON carries `filePath: string` (Task 9 reads it).

- [ ] **Step 1: Write the failing tests**

```js
it('joins a VOD playlist\'s segments, in order, into one file', ...)          // bytes === concat of the segments
it('downloads the highest-bandwidth variant of a master playlist', ...)
it('refuses an encrypted playlist with a clear message', async () => {
  await expect(hlsConcat(url, out, { fetchImpl })).rejects.toThrow(/encrypted/i)   // #EXT-X-KEY METHOD=AES-128
})
it('resolves relative segment URLs against the playlist', ...)
it('stops and leaves no file when aborted', ...)
// downloads.test.js
it('without ffmpeg, saves an HLS title as .ts', ...)
it('removes a finished download whose file was already moved away', ...)   // no throw, job gone
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/hls-concat.test.js tests/downloads.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `hlsConcat` and the `DownloadManager` fallback**

The ffmpeg mp4 path stays when ffmpeg is present. That's Docker.

- [ ] **Step 4: Run the whole backend suite**

Run: `cd backend && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/downloads backend/tests
git commit -m "feat(server): HLS downloads without ffmpeg — the pieces joined into one .ts file"
```

---

### Task 5: Solo mode in the server

**Files:**
- Modify: `backend/config.js` (`solo`, `host`, `castPort`)
- Modify: `backend/server.js:502` (listen on `config.host`; in Solo, start the LAN cast listener)
- Create: `backend/lib/soloCast.js` (the LAN listener's gate and the cast address)
- Create: `backend/routes/solo.js` (`PUT /api/solo/network`)
- Modify: `backend/lib/castLink.js` (`castBase` uses the Solo cast address when it's set)
- Test: `backend/tests/solo.test.js`

**Interfaces:**
- Produces:
  - Environment variables:
    - `SOLO=1` → `config.solo === true`
    - `HOST` (default `'0.0.0.0'`; Solo passes `127.0.0.1`) → `config.host`
    - `CAST_PORT` (Solo only) → `config.castPort`
  - `soloCast.setLanHost(host: string | null)`
  - `soloCast.castOrigin(): string | null`, which is `http://<lanHost>:<castPort>`, or null with no LAN address.
  - `soloCast.lanGate(shareToken: string): express middleware`. It lets through only `GET`/`HEAD` on paths starting `/k/<shareToken>/proxy/`. Anything else gets 404.
  - `PUT /api/solo/network { lanHost: string | null }` → 204. It's registered only when `config.solo`, behind the normal access guard (full key).
  - In Solo, with no LAN address, `castLink` returns `reachable: false` with `url` built on the loopback origin, as it does for localhost today. The app then shows "casting needs Wi-Fi".

- [ ] **Step 1: Write the failing tests**

```js
it('listens on HOST', ...)                                               // config.host from env, default 0.0.0.0
it('the LAN listener answers only the cast stream under the share token', ...)   // /k/T/proxy/cast/live/1/index.m3u8 → passes; /api/status, /k/T/api/x, /proxy/... (no token), POST → 404
it('cast links use the Wi-Fi address in Solo', ...)                      // setLanHost('192.168.1.20'), castPort 18984 → url starts http://192.168.1.20:18984/k/
it('without a Wi-Fi address, a Solo cast link is marked unreachable', ...)
it('PUT /api/solo/network exists only in Solo, and needs the key', ...)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx vitest run tests/solo.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In Solo the second listener is `http.createServer(app)` on `0.0.0.0:castPort`, with `lanGate` mounted in front of `app` for that listener only.

- [ ] **Step 4: Run the whole backend suite**

Run: `cd backend && npx vitest run && npx eslint .`
Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add backend/config.js backend/server.js backend/lib backend/routes/solo.js backend/tests/solo.test.js
git commit -m "feat(server): Solo mode — on this device only, with just the cast stream reachable on Wi-Fi"
```

---

### Task 6: Android flavors, names and updates

**Files:**
- Modify: `android/app/build.gradle.kts` (dimension `backend`: `remote`, `solo`; `solo` gets `applicationIdSuffix = ".solo"`, `resValue("string", "app_name", "StalkerWeb Solo")`, `buildConfigField("Boolean", "IS_SOLO", "true")`; `remote` gets `IS_SOLO` false)
- Modify: `android/app/src/main/java/com/stalkerweb/android/data/update/UpdateRules.kt:47-60` (`apkFor(assets, isTv, isSolo)`)
- Modify: `android/app/src/main/java/com/stalkerweb/android/data/update/UpdateManager.kt:52` (pass `BuildConfig.IS_SOLO`)
- Modify: `android/app/src/main/res/values/strings.xml` (`app_name` moves to the flavors, or stays for `remote`)
- Modify: `.github/workflows/ci.yml:81,85` and `.github/workflows/release.yml:99-119,268-302` (`MobileRemote`/`TvRemote` variant names; release builds and names all four APKs)
- Test: `android/app/src/test/java/com/stalkerweb/android/data/update/UpdateRulesTest.kt`

**Interfaces:**
- Produces:
  - `BuildConfig.IS_SOLO: Boolean`
  - Variants `mobileRemote`, `tvRemote`, `mobileSolo`, `tvSolo`
  - `fun apkFor(assets: List<Pair<String, String>>, isTv: Boolean, isSolo: Boolean = false): String?`

- [ ] **Step 1: Write the failing tests**

```kotlin
private val assets = listOf(
    "stalkerweb-solo_tv-v0.5.0.apk" to "st", "stalkerweb-solo_mobile-v0.5.0.apk" to "sm",
    "stalkerweb-tv-v0.5.0.apk" to "t", "stalkerweb-mobile-v0.5.0.apk" to "m",
)
@Test fun `each app picks only its own APK, whichever order they're listed in`() {
    for (list in listOf(assets, assets.reversed())) {
        assertEquals("t", apkFor(list, isTv = true)); assertEquals("m", apkFor(list, isTv = false))
        assertEquals("st", apkFor(list, isTv = true, isSolo = true)); assertEquals("sm", apkFor(list, isTv = false, isSolo = true))
    }
}
@Test fun `an older release without Solo APKs has none for Solo`() {
    assertNull(apkFor(assets.drop(2), isTv = true, isSolo = true))
}
```

- [ ] **Step 2: Push and run CI to verify they fail**

Run: `git push && gh workflow run ci.yml --ref feat/android-solo`
Expected: build-apk FAIL. `apkFor` has no `isSolo`.

- [ ] **Step 3: Implement**

- Flavors and BuildConfig.
- `SOLO_FORM = Regex("""-solo_(tv|mobile)[-.]""", IGNORE_CASE)`. The existing `FORM` rule stays as it is for remote.
- CI tasks become `:app:testMobileRemoteDebugUnitTest`, `:app:assembleMobileRemoteDebug :app:assembleTvRemoteDebug`.
- In the release workflow:
  - APK paths are `apk/mobileRemote/release/app-mobile-remote-release.apk` etc.
  - Assets are renamed to the four Global Constraint names.
  - The release-notes table gets two Solo rows: "Phone / tablet, all-in-one (no server)" and "TV, all-in-one (no server)".

Solo builds are added to CI in Task 7, once they can compile.

- [ ] **Step 4: Run CI to verify it passes**

Run: `gh workflow run ci.yml --ref feat/android-solo`, then watch it.
Expected: success. UpdateRulesTest passes.

- [ ] **Step 5: Commit**

```bash
git add android/app/build.gradle.kts android/app/src .github/workflows
git commit -m "feat(android): a Solo build next to the server one — its own name, app ID and update APK"
```

---

### Task 7: Node inside the Solo app

**Files:**
- Create: `android/scripts/fetch-libnode.sh` (downloads the nodejs-mobile v18.20.4 Android zip, checks a pinned SHA-256, unpacks `libnode.so` per ABI and the headers into `android/app/libnode/`, gitignored)
- Create: `android/scripts/pack-solo-server.sh` (copies `backend/` without tests, runs `npm ci --omit=dev`, zips to `android/app/src/solo/assets/server.zip`, gitignored; writes `server.version`)
- Create: `android/app/src/solo/cpp/CMakeLists.txt`, `android/app/src/solo/cpp/node-bridge.cpp` (JNI `startNode(String[] args, String[] env): Int`: `setenv` each, then `node::Start`, with stdout and stderr piped to logcat)
- Modify: `android/app/build.gradle.kts` (solo: `externalNativeBuild` CMake, `ndk.abiFilters += listOf("arm64-v8a", "armeabi-v7a")`, `jniLibs` from `libnode/`; remote variants build no native code)
- Create: `android/app/src/solo/java/com/stalkerweb/android/solo/NodeRuntime.kt`, `NodejsMobileRuntime.kt`, `ServerInstaller.kt`, `SoloEnv.kt`, `SoloServerService.kt`, `SoloServer.kt`
- Create: `android/app/src/solo/AndroidManifest.xml` (`SoloServerService` with `android:process=":node"` and `foregroundServiceType="dataSync"`; `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`)
- Create: `android/app/src/remote/java/com/stalkerweb/android/solo/SoloServer.kt` (no-op of the same API)
- Modify: `android/app/src/main/java/com/stalkerweb/android/StalkerWebApp.kt` (call `SoloServer.boot(this, container)` in `onCreate`, main process only)
- Modify: `.github/workflows/ci.yml` and `release.yml` (run both scripts before Gradle; build and test the Solo variants; check that the remote APKs contain no `libnode.so`)
- Test: `android/app/src/testSolo/java/com/stalkerweb/android/solo/SoloEnvTest.kt`, `ServerInstallerTest.kt`

**Interfaces:**
- Consumes: Solo mode environment variables (Task 5), `BuildConfig.IS_SOLO` (Task 6).
- Produces:
  - `interface NodeRuntime { fun start(entry: File, args: List<String>, env: Map<String, String>): Int }`. It blocks until Node exits and returns the exit code.
  - `object ServerInstaller { fun ensureInstalled(context: Context, assets: AssetSource, versionTag: String, root: File): File }`. It returns `root/<versionTag>/backend/server.js`. It extracts `server.zip` only when that folder is missing, and deletes other versions' folders.
  - `object SoloEnv { fun build(port: Int, castPort: Int, accessKey: String, dataDir: File, downloadDir: File, version: String): Map<String, String> }`, which returns:
    - `SOLO=1`, `HOST=127.0.0.1`, `PORT`, `CAST_PORT`, `ACCESS_KEY`
    - `DATA_DIR`, `DOWNLOAD_DIR`, `APP_VERSION`
    - `NODE_ENV=production`
  - `object SoloServer`:
    - `fun boot(app: Application, container: AppContainer)`. On first run it makes a 32-byte random key (Base64url) and picks two free ports (`ServerSocket(0)`), saved in `AppPrefs` as `soloPort`, `soloCastPort`, `soloKey`. It then sets `prefs.serverUrl = "http://127.0.0.1:$soloPort"` and `prefs.accessKey = soloKey`, and starts `SoloServerService` with the ports and key as Intent extras.
    - `suspend fun awaitReady(client: OkHttpClient, timeoutMs: Long = 20_000): Boolean` polls `GET /api/health` every 200 ms.
  - The remote no-op `SoloServer.boot` does nothing, and its `awaitReady` returns true.
  - `SoloServerService` runs `NodeRuntime.start` on a thread. If Node exits, the `:node` process exits too: Node can start only once per process. The service is `START_REDELIVER_INTENT`, so Android brings it back with the same extras. The 'starting'/'running' notification is shown only while foreground is needed (Task 8 asks for it).

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test fun `the environment puts the server on this device only, with its key and folders`() {
    val env = SoloEnv.build(18983, 18984, "k3y", File("/d"), File("/d/dl"), "0.5.0")
    assertEquals("127.0.0.1", env["HOST"]); assertEquals("1", env["SOLO"]); assertEquals("18983", env["PORT"])
    assertEquals("18984", env["CAST_PORT"]); assertEquals("k3y", env["ACCESS_KEY"]); assertEquals("/d", env["DATA_DIR"])
}
@Test fun `installs the server once per version, and clears older ones`() { /* temp dir; fake AssetSource with a small zip; second call doesn't re-extract (mtime same); new tag removes the old folder */ }
@Test fun `an install cut short is redone`() { /* folder without the done-marker → extracted again */ }
```

- [ ] **Step 2: Add the Solo variants to CI and run it to verify these fail**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected: FAIL. `SoloEnv` doesn't exist yet.

- [ ] **Step 3: Implement the scripts, the native bridge, the Gradle wiring and the Kotlin classes**

- [ ] **Step 4: Run CI to verify it passes**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected:
- Success, with all four APKs built.
- The Solo APK holds `lib/arm64-v8a/libnode.so` and `assets/server.zip`.
- The remote APKs hold neither: the CI step `unzip -l … | grep -c libnode` prints 0.

- [ ] **Step 5: Hand-check on a device (owner)**

Install the `tvSolo` debug APK from the CI artifacts. Expected:
- `adb logcat | grep stalkerweb` shows `stalkerweb running on`.
- `adb shell run-as com.stalkerweb.android.tv.solo ls files` lists the data dir.
- `adb shell am kill com.stalkerweb.android.tv.solo:node` (where `pidof` is available) brings the server back within a few seconds.

- [ ] **Step 6: Commit**

```bash
git add android .github/workflows .gitignore
git commit -m "feat(android): Solo runs the StalkerWeb server on the device (nodejs-mobile, its own process, restarted if Android stops it)"
```

---

### Task 8: Solo start-up, casting address and the parts hidden

**Files:**
- Modify: `android/app/src/main/java/com/stalkerweb/android/MainActivity.kt:161-250`. In Solo:
  - show a "Starting…" screen until `SoloServer.awaitReady`;
  - `startDest` is `Shell` (never Setup);
  - an `AccessProblem` event restarts the server instead of opening Setup.
- Modify: `android/app/src/main/java/com/stalkerweb/android/ui/settings/SettingsScreen.kt:168,187,287,353`. In Solo, hide:
  - the "Viewers" card;
  - the "Activity" card;
  - the "StalkerWeb server" card.

  The filters cards' titles become "Your filters" and "Your channels".
- Modify: `android/app/src/main/java/com/stalkerweb/android/ui/shell/*` (no "Who's watching?" entry in Solo)
- Create: `android/app/src/solo/java/com/stalkerweb/android/solo/CastNetwork.kt` (a ConnectivityManager callback: on Wi-Fi up or change, sends `PUT /api/solo/network { lanHost }` with the Wi-Fi IPv4; on Wi-Fi lost, `{ lanHost: null }`)
- Create: `android/app/src/main/java/com/stalkerweb/android/data/repo/SoloRules.kt`, pure rules shared by both flavors
- Modify: the cast button's message when the cast link is `reachable: false` (in Solo: "Casting needs Wi-Fi")
- Modify: `SoloServerService`. It goes foreground while playing, casting or downloading, through `SoloServer.hold(reason: String)` and `release(reason)`, called from the players and the downloads view model. These are no-ops in remote.
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/SoloRulesTest.kt`

**Interfaces:**
- Consumes: `SoloServer` (Task 7), `PUT /api/solo/network` (Task 5).
- Produces:
  - `enum class SettingsCard { Viewers, Filters, Channels, MoviesSeries, Activity, Server, PlaybackGuide, … }` and `fun shownCards(isSolo: Boolean): List<SettingsCard>`, with SettingsScreen rendering from it.
  - `fun lanHostOf(addresses: List<String>): String?`, the first private IPv4: 10/8, 172.16/12 or 192.168/16, ignoring loopback and link-local.
  - `fun castMessage(reachable: Boolean, isSolo: Boolean): String?`

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test fun `Solo shows no viewers, activity or server settings`() {
    assertFalse(shownCards(isSolo = true).any { it in setOf(SettingsCard.Viewers, SettingsCard.Activity, SettingsCard.Server) })
    assertEquals(SettingsCard.entries.toList(), shownCards(isSolo = false))
}
@Test fun `the cast address is the Wi-Fi's private IPv4`() {
    assertEquals("192.168.1.20", lanHostOf(listOf("127.0.0.1", "fe80::1", "169.254.3.3", "192.168.1.20")))
    assertNull(lanHostOf(listOf("127.0.0.1", "100.64.0.5")))   // mobile data (carrier NAT) only
}
@Test fun `without Wi-Fi Solo says casting needs it`() {
    assertEquals("Casting needs Wi-Fi", castMessage(reachable = false, isSolo = true))
    assertNull(castMessage(reachable = true, isSolo = true))
}
```

- [ ] **Step 2: Run CI to verify they fail**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected: FAIL, unresolved `shownCards`.

- [ ] **Step 3: Implement**

Add `ThemeUsageTest`-style coverage if any new UI is added: use `TvTextField` and `TipIconButton`, never raw `OutlinedTextField` or `IconButton`.

- [ ] **Step 4: Run CI to verify it passes**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected: success.

- [ ] **Step 5: Hand-check (owner)**

On a fresh `mobileSolo` install, checks 1–4 are in the remaining steps, and check 5 is done later:
1. "Starting…", then the Portal screen.
2. Add a made-up-free real portal.
3. A channel plays.
4. Settings shows no Viewers, Activity or Server cards.
5. Cast a raw-TS channel. It plays on the TV, after Task 3.

- [ ] **Step 6: Commit**

```bash
git add android
git commit -m "feat(android): Solo starts on its own server, sends the cast address on Wi-Fi, and leaves out viewers and server settings"
```

---

### Task 9: Downloads to the Downloads folder (Solo)

**Files:**
- Create: `android/app/src/solo/java/com/stalkerweb/android/solo/DownloadPublisher.kt`
- Modify: `android/app/src/main/java/com/stalkerweb/android/data/api/Part4Models.kt:34-43` (`DownloadJob.filePath: String? = null`)
- Create: `android/app/src/main/java/com/stalkerweb/android/data/repo/DownloadPublishRules.kt`
- Modify: `android/app/src/solo/AndroidManifest.xml` (`WRITE_EXTERNAL_STORAGE` with `maxSdkVersion="28"`)
- Modify: `android/app/src/main/java/com/stalkerweb/android/ui/downloads/DownloadsScreen.kt` (a finished Solo job reads "Saved to Downloads/StalkerWeb")
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/DownloadPublishRulesTest.kt`

**Interfaces:**
- Consumes: `filePath` on finished jobs (Task 4), `DownloadsRepository.events()`.
- Produces:
  - `fun toPublish(jobs: List<DownloadJob>, published: Set<String>): List<DownloadJob>` returns jobs with status `done`, a `filePath`, and an id not yet published.
  - `fun publicName(job: DownloadJob): String` builds the file name:
    - from `filePath`'s name;
    - characters MediaStore refuses replaced with `_`;
    - extension kept.
  - `fun mimeOf(name: String): String` maps `.ts` → `video/mp2t`, `.mp4` → `video/mp4`, `.mkv` → `video/x-matroska`, else `video/*`.
  - `DownloadPublisher.start(scope)` collects the events. For each job to publish:
    - Android 10+: `MediaStore.Downloads` insert with `RELATIVE_PATH = "Download/StalkerWeb"` and `IS_PENDING` 1 → copy → 0.
    - Android 8–9: ask for the permission once, then copy to `Environment.DIRECTORY_DOWNLOADS/StalkerWeb`.
    - Then delete the private file, and add the id to `AppPrefs.publishedDownloads`.

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test fun `publishes each finished download once`() {
    val jobs = listOf(job("a", "done", "/d/dl/Heat (1995).ts"), job("b", "downloading", null), job("c", "done", "/d/dl/x.mp4"))
    assertEquals(listOf("a"), toPublish(jobs, published = setOf("c")).map { it.id })
}
@Test fun `names and types for the Downloads folder`() {
    assertEquals("Heat (1995).ts", publicName(job("a", "done", "/d/dl/Heat (1995).ts")))
    assertEquals("A_B.mp4", publicName(job("a", "done", "/d/dl/A:B.mp4")))
    assertEquals("video/mp2t", mimeOf("x.ts"))
}
```

- [ ] **Step 2: Run CI to verify they fail**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected: FAIL.

- [ ] **Step 3: Implement**

Start `DownloadPublisher` from `SoloServer.boot`. The remote build has no publisher.

- [ ] **Step 4: Run CI to verify it passes**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected: success.

- [ ] **Step 5: Hand-check (owner)**

Download a file-served movie and an HLS one. Both appear in the Files app under `Download/StalkerWeb`, and play in VLC.

- [ ] **Step 6: Commit**

```bash
git add android
git commit -m "feat(android): Solo saves downloads to the Downloads folder, where they can be found and copied out"
```

---

### Task 10: Release packaging and docs

**Files:**
- Modify: `.github/workflows/release.yml` (four APKs as release assets; Solo build steps from Task 7)
- Modify: `README.md` (a "StalkerWeb Solo" section: what it is, no server needed, one person, Wyzie key masked, casting on Wi-Fi, downloads in Downloads, Node 18 note)
- Test: the release workflow run on the tag

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Check the workflow builds all four APKs on a branch run**

Run: `gh workflow run ci.yml --ref feat/android-solo`
Expected: success, with four APK artifacts.

- [ ] **Step 2: Write the README section and commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "docs: StalkerWeb Solo — the all-in-one Android app, and its release APKs"
```

- [ ] **Step 3: After the owner says "merge":**

1. Tag `vX.Y.Z` and watch Release.
2. Expected assets:
   - `stalkerweb-mobile-v…`
   - `stalkerweb-tv-v…`
   - `stalkerweb-solo_mobile-v…`
   - `stalkerweb-solo_tv-v…`
3. Remind the owner to redeploy in Portainer (the server changed: casting without ffmpeg, HLS download fallback, Node 18).
