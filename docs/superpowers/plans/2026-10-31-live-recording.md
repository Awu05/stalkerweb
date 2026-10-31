# Live TV Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** record live TV, either now from the live player or ahead of time from the guide, on the server, with a Recordings page in the web and Android apps (Solo included).

**Architecture:**
- **Server:** a `RecordingStore` keeps the schedule and the finished list, and a `Recorder` writes one recording to a `.ts` file. The recorder reads this server's own `/proxy/stream/<id>` through `readSelfStream`, so recordings get the live buffer and restart handling. A `RecordingScheduler` starts and stops them on time and recovers after a restart. A stream-limit check counts the server's open portal streams.
- **Routes:** under `/api/recordings`. Finished files play through a `/proxy/recording/:id` route.
- **Apps:** a Record button in the live player, a Record option in the guide, and a Recordings page. Solo publishes finished files to Downloads/StalkerWeb with the existing DownloadPublisher.

**Tech Stack:** Node 18/20 + Express 5 + vitest; React + vitest; Kotlin + Compose (CI only).

**Spec:** `docs/superpowers/specs/2026-10-31-live-recording-design.md`

## Global Constraints
- **Files:** one `.ts` file per recording, with no re-encoding. The folder is `RECORDINGS_DIR`, or `DATA_DIR/recordings`.
- **Default lengths:**
  - Padding defaults to 2 minutes before and 5 minutes after. Both can be changed in Settings (`record_pad_before_min`, `record_pad_after_min`).
  - Record now offers: until the programme ends (the default), 30 min, 1 h, 2 h, until stopped.
- **Disk space:** a recording needs at least 1 GB free to start. On disk full it stops cleanly and keeps what it has.
- **Names:** `Channel – Programme – YYYY-MM-DD HH:MM.ts`, in the server's timezone setting. Characters a filesystem refuses become `_`.
- **Stream limit:** the setting `max_streams` defaults to 1. It counts watching, casting and recordings.
- **Recordings belong to the viewer who made them.** Lists can show everyone's, labelled by viewer.
- **Kept until deleted.** There's no auto-delete. Series recording is out of scope.
- **Server code:** must run on Node 18. Use per-request AbortControllers, and no AbortSignal.any.
- **No real identifiers** anywhere. Use MAC 00:1A:79:12:34:56 and portal.example. TS fixtures come from `tests/helpers/makeTs.js`.
- **Style:** plain-language comments in the house voice. Android uses TipIconButton / TvTextField and theme tokens. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git add -A`.

## Review Focus
1. **A source that restarts or stalls mid-recording:** the recording carries on, with a gap, and fails only if the source stays down past its end time. Test in Task 2.
2. **The server restarts during a scheduled recording:** the part already written is kept as a finished recording, marked "(part 1)". A new recording for the rest starts at once, titled "(part 2)" and linked by `partOf`. Nothing is lost silently. Test in Task 3.
3. **Two recordings that overlap with `max_streams` 1:** the second one is refused at scheduling time with "overlaps", and at start time the recording wins over watching. Test in Task 4.
4. **A programme whose guide times change after it's scheduled:** the scheduled times stay as booked, with padding as set then. That's the simple rule; say so in the UI. Test in Task 3.
5. **Deleting a recording while it plays or records:** stop it first, then delete. The file is never left half-written. Test in Task 4.

---

### Task 1: The recording store
**Files:**
- Create: `backend/recordings/RecordingStore.js`, `backend/tests/recording-store.test.js`

**Interfaces:**
- Produces: `new RecordingStore(dataDir, { now })` with these methods:
  - `list(viewerId?)` returns `Recording[]`, newest first.
  - `get(id)`
  - `schedule({ viewerId, channelId, channelName, title, startAt, endAt, padBeforeMin, padAfterMin })` returns a `Recording` with `status: 'scheduled'`.
  - `update(id, patch)`
  - `remove(id)`
  - `due(now)` returns the recordings that should be running.
  - `overlapping(startAt, endAt)`
- **`Recording`:** `{ id, viewerId, channelId, channelName, title, startAt, endAt, status: 'scheduled'|'recording'|'done'|'failed'|'missed'|'cancelled', filePath?, bytes, error?, partOf?, createdAt }`. Times are ms; `startAt`/`endAt` already include the padding.
- Saved with `lib/jsonFile.js` (`writeJsonAtomic` / `DebouncedSave`) to `DATA_DIR/recordings.json`.

- [ ] **Step 1: Tests**
  - `'schedules with padding applied'`: startAt = programme start − 2 min, endAt = programme end + 5 min.
  - `'lists newest first, per viewer or all'`
  - `'due() returns what should be recording now'`
  - `'survives a reload from disk'`
  - `'overlapping() finds clashes'`
- [ ] **Step 2: Run** `cd backend && npx vitest run tests/recording-store.test.js`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): a store for scheduled and finished recordings`.

### Task 2: The recorder
**Files:**
- Create: `backend/recordings/Recorder.js`, `backend/tests/recorder.test.js`

**Interfaces:**
- Consumes: `readSelfStream(url, { onData, onBreak, signal, userAgent, fetchImpl })` from `backend/stalker/selfStreamReader.js`.
- Produces: `startRecording({ url, filePath, endAt, signal, now, onBytes, freeBytes, reader = readSelfStream })`. It returns a promise of `{ status: 'done'|'failed', bytes, error? }`.
  - It writes chunks with backpressure to `filePath + '.part'` and renames the file on the way out.
  - It stops at `endAt`, on abort (status done, with what it has), or on disk full (done, with what it has, plus `error: 'disk full'`).
  - It ignores `onBreak` (a gap) unless no data arrives for `min(5 min, time left)`, in which case it fails with "the channel stopped sending".

- [ ] **Step 1: Tests** (fake reader feeding `makeTs`):
  - `'writes the stream to one .ts file and renames it at the end time'`
  - `'carries on across a source restart'`: onBreak, then more data, gives one file with both parts.
  - `'fails when the source sends nothing for too long'`
  - `'stopping early keeps what was recorded'`
  - `'disk full stops cleanly with what it has'`: freeBytes returns 0 partway through.
  - `'refuses to start with under 1 GB free'`
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests on Node 18 and 20. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): record a live channel to a .ts file, across source restarts`.

### Task 3: The scheduler
**Files:**
- Create: `backend/recordings/RecordingScheduler.js`, `backend/tests/recording-scheduler.test.js`
- Modify: `backend/server.js`. Wire it up with `selfStreamUrl(id)` (server.js ~356) and `appState.internalUA`, start it after the portal is ready, and stop recordings cleanly on shutdown.

**Interfaces:**
- Consumes: `RecordingStore` (Task 1) and `startRecording` (Task 2).
- Produces: `new RecordingScheduler({ store, start: startRecording, urlFor, dirFor, nameFor, now, tickMs = 5000, setTimer })` with these methods:
  - `run()`
  - `stopAll()`
  - `startNow({ viewerId, channelId, channelName, title, endAt })`
  - `stop(id)`
  - `active()` returns the ids recording now.
- `nameFor(rec)` builds `Channel – Programme – YYYY-MM-DD HH:MM.ts` and makes it safe for the filesystem.

- [ ] **Step 1: Tests:**
  - `'starts a scheduled recording at its start and stops at its end'`
  - `'after a restart, keeps the part written as "(part 1)" and starts "(part 2)" for the rest; marks one whose time passed as missed'`
  - `'keeps the booked times when the guide changes later'`
  - `'stop() ends a recording early'`
  - `'names files Channel – Programme – date time, safely'`
- [ ] **Step 2–4:** run (FAIL), implement, run on Node 18 and 20 (PASS).
- [ ] **Step 5: Commit** `feat(server): recordings start and stop on time, and recover after a restart`.

### Task 4: Routes, stream limit and playback
**Files:**
- Create: `backend/routes/recordings.js`, `backend/lib/streamLimit.js`, `backend/tests/recordings-routes.test.js`
- Modify: `backend/server.js` (mount the router), `backend/routes/proxy.js` (`GET /proxy/recording/:id` serves the finished file with Range support, under the normal access rules and the share token), `backend/routes/settings.js` (`max_streams` default 1, `record_pad_before_min` 2, `record_pad_after_min` 5).

**Interfaces:**
- **Endpoints**, all for the viewer in `req.viewer`:
  - `GET /api/recordings` returns `{ recordings: Recording[] }`. With `?all=1` it returns everyone's, with `viewerName`.
  - `POST /api/recordings` takes `{ channelId, channelName, title, startAt, endAt }` (a guide programme; padding comes from settings) and returns 201 with the `Recording`. It returns 409 `{ error, clash: Recording }` when it overlaps and `max_streams` would be exceeded.
  - `POST /api/recordings/now` takes `{ channelId, channelName, title, endAt | null }` and returns 201 with the `Recording`. It returns 409 `{ error, takesStream: true }` when watching already uses the limit; resending with `{ force: true }` starts it anyway.
  - `POST /api/recordings/:id/stop`
  - `DELETE /api/recordings/:id`: if the recording is running, stop it first, then delete the file and the entry.
- `streamLimit.inUse(appState)` counts the active streams (the activity tracker's live streams, cast sessions and running recordings). `streamLimit.wouldExceed(appState, extra = 1)`.
- At a scheduled start, a recording wins: watching on the same account gets a `recording-took-stream` activity event that the players show.

- [ ] **Step 1: Tests:**
  - `'schedules from a guide programme with the padding from settings'`
  - `'refuses an overlapping recording with max_streams 1'`
  - `'record now warns when watching uses the stream, and force starts it'`
  - `'stop and delete; deleting a running recording stops it first'`
  - `'plays a finished recording with Range'`
  - `'only the owner sees theirs unless all=1'`
- [ ] **Step 2–4:** run (FAIL), implement, run the full backend suite on Node 18 and 20 plus `npx eslint .` (PASS).
- [ ] **Step 5: Commit** `feat(server): recordings API, stream limit and playback`.

### Task 5: Web app
**Files:**
- Create: `frontend/src/pages/RecordingsPage.jsx`, `frontend/src/lib/recordings.js` (+ `recordings.test.js`), `frontend/src/components/RecordButton.jsx`
- Modify:
  - `frontend/src/stalkerApi.js`: API calls.
  - `frontend/src/App.jsx`: `/recordings` route.
  - The sidebar nav: Recordings entry.
  - `frontend/src/pages/PlayerPage.jsx`: the Record button with its length choice (until the programme ends / 30 min / 1 h / 2 h / until stopped), and a "recording" badge while recording; on a 409 `takesStream`, a confirm.
  - `frontend/src/pages/GuidePage.jsx` / `EpgGridPage.jsx`: a Record option on a programme, which shows the clash message on 409.
  - Settings: `max_streams` and the two padding fields.
  - `VodPlayerPage.jsx` or a light reuse: plays `/proxy/recording/:id` with resume.

**Interfaces:**
- `recordings.js`, pure:
  - `groupRecordings(list, now)` returns `{ scheduled, recording, done }` (failed and missed go in done, labelled).
  - `recordingLabel(r)`: e.g. "Tonight 20:00–21:05" or "Recorded 31 Oct · 1 h 05 · 2.1 GB".
  - `endForChoice(choice, now, programmeEnd)`

- [ ] **Step 1: Tests** for the three pure functions, with the spec's values.
- [ ] **Step 2–4:** run (FAIL), implement, then `npx vitest run && npx eslint src && npm run build` (PASS).
- [ ] **Step 5: Commit** `feat(web): record live TV now or from the guide, and a Recordings page`.

### Task 6: Android app (phone, TV and Solo)
**Files:**
- Create:
  - `ui/recordings/RecordingsScreen.kt` and `RecordingsViewModel.kt`
  - `data/repo/RecordingsRepository.kt`
  - `data/repo/RecordingRules.kt` + test
- Modify:
  - `data/api/StalkerApi.kt` / models: the endpoints.
  - `ui/shell/AppShell.kt`: a Recordings section like DOWNLOADS.
  - `ui/player/PlayerScreen.kt`: a Record button in the controls (TipIconButton), the length choice and the confirm on 409.
  - `ui/guide/GuideScreen.kt`: Record on a programme.
  - `ui/settings/SettingsScreen.kt`: the limit and padding.
  - Playing a recording reuses the VOD player with a recording source.
  - **Solo:** `src/solo/.../DownloadPublisher.kt` also publishes finished recordings to Download/StalkerWeb. Recordings use the same confinement rule (inside `SoloEnv` recordings dir, no symlinks). `SoloEnv` passes `RECORDINGS_DIR`. A running recording takes the DOWNLOADING-style hold so the server stays up.

**Interfaces:**
- `RecordingRules.kt` is the pure counterpart of the web's: `groupRecordings`, `recordingLabel`, `endForChoice`.

- [ ] **Step 1: Tests** for the pure rules, with the same values as the web's.
- [ ] **Step 2–4:** push, run `gh workflow run ci.yml --ref feat/live-recording`, watch the newest run (RED on missing rules, then GREEN, every job including the release builds).
- [ ] **Step 5: Commit** `feat(android): record live TV now or from the guide, and a Recordings screen (Solo saves them to Downloads)`.

### Task 7: Docs
**Files:**
- Modify: `README.md`, with a Recording section covering what it does, where files go, the stream limit setting, and that recordings are kept until deleted.

- [ ] **Step 1: Write it.** Commit `docs: live TV recording`.
- [ ] **Step 2: Open the PR** and run CI. Merge and tag only when the owner says so.
