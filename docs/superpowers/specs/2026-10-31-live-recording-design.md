# Live TV recording

## Why
The owner wants to keep live TV to watch later: what's on right now, and programmes coming up in the guide.

## What it does
- **Record now.** A Record button in the live player, in the web app and the Android phone and TV apps. It records the channel playing until Stop, or for a length picked when starting: until the programme ends (the default), 30 min, 1 h, 2 h or until stopped.
- **Record from the guide.** A Record option on any programme still to come, or on now, in the guide (web and Android). The server starts on the guide's start time and stops on its end. It pads each side by default: 2 minutes before, 5 minutes after. The padding can be changed in Settings.
- **Recordings list.** A new Recordings page in the apps lists:
  - **Scheduled:** channel, programme, time; cancel.
  - **Recording now:** elapsed time and size; stop.
  - **Done:** title, channel, date, length, size; play, delete. Failed ones are listed with the reason.

  A finished recording plays in the apps' normal video player, with resume and the settings gear, like a movie.

## How it works
- **The server records**, even with every app closed. A recording reads this server's own stream for the channel, so it goes through the live buffer and restart smoother, which handle the 4K stutter. It's written to disk as it arrives, as one `.ts` file, with no re-encoding.
- **Source restarts:** the reader the segmenter casting uses (selfStreamReader) already handles these. A gap is recorded as a gap; a recording doesn't fail on a short outage. A source that stays down past the end time fails the recording, with the reason shown.
- **Where files go:** the Docker server saves them in a `recordings` folder next to downloads (`DATA_DIR/recordings`, or `RECORDINGS_DIR`). Solo records on the device itself and publishes finished files to Downloads/StalkerWeb, the same way downloads go there. In-app, Solo plays them from its own list.
- **Schedules survive a restart.** They're saved in the data folder. After a restart, a recording that should be running starts at once, and one whose time has passed is marked missed.
- **Per viewer:** recordings belong to the viewer who made them, like My List. The Docker server also lets anyone see everyone's recordings, labelled by viewer, so a shared household can find them.

## The provider's stream limit
Many accounts allow only one or two streams at once. Settings gets a "Streams your provider allows at once" setting (default 1). The server counts its own open portal streams, covering watching, casting and recordings. When a recording would go over the limit:
- **Starting now:** say so before starting ("You're already watching, and your provider allows 1 stream — recording will stop what's playing. Record anyway?").
- **Scheduled clashes:** shown when scheduling ("This overlaps another recording"). At start time, the recording takes priority over watching; whoever is watching sees a message that a recording took the stream.

## My calls, for the owner to check
- Recordings are kept until deleted. There's no auto-delete.
- Each recording needs at least 1 GB free to start, and stops cleanly with what it has if the disk fills.
- Padding defaults to 2 min before and 5 min after.
- A recording is named "Channel – Programme – 2026-10-31 20:00.ts".
- There's no series recording ("every episode of this show") yet; it's a good next step.

## Non-goals
- Re-encoding to mp4 or another format.
- Recording on one device to play on another in Solo; Solo has one device.
- Recording several channels at once beyond the provider's limit.

## Tests
- Server: scheduler (timing, padding, restart recovery, missed), recorder (writes a TS stream, survives a source restart, stops on time, disk-full handling), stream-limit counting, routes.
- Web and Android: pure rules for the list's states and the limit messages.
- CI green on Node 18 and 20, and the four APKs.
