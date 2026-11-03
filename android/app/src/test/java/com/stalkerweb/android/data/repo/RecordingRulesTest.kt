package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.api.RecordingDisk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

// The same inputs and answers as the web's (frontend/src/lib/recordings.test.js).
class RecordingRulesTest {
    private val min = 60_000L
    private val now = Instant.parse("2026-10-31T18:00:00Z").toEpochMilli()   // Sat 31 Oct, 18:00 UTC
    private val utc = ZoneOffset.UTC
    private val mb = 1024L * 1024
    private val gb = 1024.0 * 1024 * 1024

    private fun rec(id: String = "r", status: String, startAt: Long, endAt: Long?, bytes: Long = 0, error: String? = null, endedAt: Long? = null) =
        Recording(id = id, channelId = "1", channelName = "News 24", title = "Evening News", startAt = startAt, endAt = endAt,
            status = status, bytes = bytes, error = error, endedAt = endedAt, createdAt = now)

    @Test fun `splits into scheduled (soonest first), recording, and done (newest first) — cancelled left out`() {
        val list = listOf(
            rec("a", "scheduled", now + 120 * min, now + 180 * min),
            rec("b", "scheduled", now + 60 * min, now + 90 * min),
            rec("c", "recording", now - 10 * min, null),
            rec("d", "done", now - 300 * min, now - 240 * min),
            rec("e", "failed", now - 100 * min, now - 50 * min),
            rec("f", "missed", now - 600 * min, now - 500 * min),
            rec("g", "cancelled", now, now + min),
        )
        val g = groupRecordings(list)
        assertEquals(listOf("b", "a"), g.scheduled.map { it.id })
        assertEquals(listOf("c"), g.recording.map { it.id })
        assertEquals(listOf("e", "d", "f"), g.done.map { it.id })
        assertFalse(g.isEmpty)
        assertTrue(groupRecordings(listOf(rec("g", "cancelled", now, now))).isEmpty)
    }

    @Test fun `a booked one says when it records`() {
        assertEquals("Today 20:00–21:05", recordingLabel(rec(status = "scheduled", startAt = now + 120 * min, endAt = now + 185 * min), now, utc))
        assertEquals("Tomorrow 20:00–21:00", recordingLabel(rec(status = "scheduled", startAt = now + 26 * 60 * min, endAt = now + 27 * 60 * min), now, utc))
        assertEquals("Tue 3 Nov 18:00–18:30", recordingLabel(rec(status = "scheduled", startAt = now + 3 * 1440 * min, endAt = now + 3 * 1440 * min + 30 * min), now, utc))
    }

    @Test fun `one recording now says how long, and how big so far`() {
        assertEquals("Recording · 12 min · 340 MB", recordingLabel(rec(status = "recording", startAt = now - 12 * min, endAt = null, bytes = 340 * mb), now, utc))
    }

    @Test fun `a finished one says when, how long, how big`() {
        assertEquals("Recorded 30 Oct · 1 h 05 · 2.1 GB",
            recordingLabel(rec(status = "done", startAt = now - 1440 * min, endAt = now - 1440 * min + 65 * min, bytes = (2.1 * gb).toLong()), now, utc))
    }

    @Test fun `a scheduled one says how long it was booked for`() {
        fun s(status: String, startAt: Long = now - 12 * min, endAt: Long = now - 12 * min + 67 * min) = rec(status = status, startAt = startAt, endAt = endAt).copy(source = "scheduled")
        assertEquals("Today 20:00–21:07 · 1 h 07", recordingLabel(s("scheduled", now + 120 * min, now + 187 * min), now, utc))
        assertEquals("Recording · 12 min of 1 h 07 · 340 MB", recordingLabel(s("recording").copy(bytes = 340 * mb), now, utc))
        assertEquals("Recorded 31 Oct · 1 h 05 of 1 h 07 · 2.1 GB",
            recordingLabel(s("done").copy(endedAt = now - 12 * min + 65 * min, bytes = (2.1 * gb).toLong()), now, utc))
        // A part 2 (after a restart) says its part 1's booking, not the time that was left.
        assertEquals("Recording · 2 min of 1 h 07 · 340 MB",
            recordingLabel(s("recording", now - 2 * min, now + 25 * min).copy(bookedMs = 67 * min, bytes = 340 * mb), now, utc))
        // Record now keeps its lines as they were, a set length or not.
        assertEquals("Recording · 12 min · 340 MB",
            recordingLabel(rec(status = "recording", startAt = now - 12 * min, endAt = now + 18 * min, bytes = 340 * mb).copy(source = "manual"), now, utc))
        assertEquals("Manual", sourceLabel(rec(status = "done", startAt = now, endAt = now).copy(source = "manual")))
        assertEquals("Scheduled", sourceLabel(s("done")))
        assertEquals("", sourceLabel(rec(status = "done", startAt = now, endAt = now)))
    }

    @Test fun `one stopped early shows how long it really ran`() {
        assertEquals("Recorded 31 Oct · 20 min · 200 MB",
            recordingLabel(rec(status = "done", startAt = now - 120 * min, endAt = now + 60 * min, endedAt = now - 100 * min, bytes = 200 * mb), now, utc))
    }

    @Test fun `failed and missed say why`() {
        assertEquals("Failed — Less than 1 GB free on the disk — the recording didn't start.",
            recordingLabel(rec(status = "failed", startAt = now, endAt = now, error = "Less than 1 GB free on the disk — the recording didn't start."), now, utc))
        assertEquals("Failed — the recording didn't work", recordingLabel(rec(status = "failed", startAt = now, endAt = now), now, utc))
        assertEquals("Missed — the server wasn't running", recordingLabel(rec(status = "missed", startAt = now, endAt = now), now, utc))
    }

    @Test fun `until the programme ends is offered only with a guide end still to come`() {
        assertEquals(listOf("programme", "30", "60", "120", "stop"), recordChoices(now + 25 * min, now).map { it.id })
        assertEquals(listOf("30", "60", "120", "stop"), recordChoices(null, now).map { it.id })
        assertEquals(listOf("30", "60", "120", "stop"), recordChoices(now - min, now).map { it.id })
    }

    @Test fun `until the programme ends (an hour when the guide has no end), a set time, or until stopped`() {
        assertEquals(listOf("programme", "30", "60", "120", "stop"), RECORD_CHOICES.map { it.id })
        assertEquals("Until the programme ends", RECORD_CHOICES.first().label)
        assertEquals(now + 25 * min, endForChoice("programme", now, now + 25 * min))
        assertEquals(now + 60 * min, endForChoice("programme", now, null))
        assertEquals(now + 60 * min, endForChoice("programme", now, now - min))   // the guide's programme already over
        assertEquals(now + 30 * min, endForChoice("30", now))
        assertEquals(now + 120 * min, endForChoice("120", now))
        assertNull(endForChoice("stop", now))
    }

    @Test fun `keeps where a recording was left, and forgets it once it is near the end`() {
        assertEquals(600.0, recordingPositionToKeep(600.0, 3600.0)!!, 0.0)
        assertNull(recordingPositionToKeep(3500.0, 3600.0))   // past 95%: finished
        assertNull(recordingPositionToKeep(10.0, 0.0))         // no length known: nothing to keep
    }

    @Test fun `Solo keeps its server up while one records, or one is about to`() {
        assertFalse(recordingNeedsServer(emptyList(), now))
        assertTrue(recordingNeedsServer(listOf(rec(status = "recording", startAt = now - min, endAt = null)), now))
        assertTrue(recordingNeedsServer(listOf(rec(status = "scheduled", startAt = now + 10 * min, endAt = now + 60 * min)), now))
        assertFalse(recordingNeedsServer(listOf(rec(status = "scheduled", startAt = now + 60 * min, endAt = now + 90 * min)), now))
        assertFalse(recordingNeedsServer(listOf(rec(status = "done", startAt = now - 60 * min, endAt = now - min)), now))
    }

    @Test fun `Solo saves each finished recording's ts to Downloads once, never its index`() {
        val done = rec("d", "done", now - 60 * min, now - min).copy(filePath = "/data/recordings/News 24 – Evening News – 2026-10-31 17.00.ts", bytes = mb)
        val list = listOf(
            done,
            rec("r", "recording", now - min, null).copy(filePath = "/data/recordings/x.ts"),
            rec("e", "done", now - 60 * min, now - min).copy(filePath = null),
            rec("i", "done", now - 60 * min, now - min).copy(filePath = "/data/recordings/x.ts.index"),
            rec("z", "done", now - 60 * min, now - min).copy(filePath = "/data/recordings/empty.ts", bytes = 0),
        )
        assertEquals(listOf("d"), recordingsToPublish(list, emptySet()).map { it.id })
        assertEquals(emptyList<String>(), recordingsToPublish(list, setOf("d")).map { it.id })
        assertEquals(emptyList<String>(), recordingsToPublish(list, setOf(goneKey("d"))).map { it.id })
        assertEquals("News 24 – Evening News – 2026-10-31 17.00.ts", publicRecordingName(done))
    }

    @Test fun `the disk line says what the recordings take and what's free`() {
        val gb = 1024L * 1024 * 1024
        assertEquals("Recordings use 38.0 GB · 112.0 GB free", diskLine(RecordingDisk(usedBytes = 38 * gb, freeBytes = 112 * gb)))
        assertEquals("Recordings use 340 MB", diskLine(RecordingDisk(usedBytes = 340L * 1024 * 1024, freeBytes = null)))
        assertEquals("5.0 GB free for recordings", diskLine(RecordingDisk(usedBytes = 0, freeBytes = 5 * gb)))
        assertEquals("", diskLine(null))
    }

    @Test fun `the Recordings screen says where they're kept`() {
        assertTrue(recordingsHint(isSolo = false).contains("on the server"))
        assertTrue(recordingsHint(isSolo = true).contains("Downloads/StalkerWeb"))
    }

    @Test fun `the Record button finds the recording running on its channel, started anywhere`() {
        val list = listOf(
            rec("a", "recording", now - min, null),                                   // channel 1
            rec("b", "done", now - 60 * min, now - min).copy(channelId = "2"),
            rec("c", "scheduled", now + 60 * min, now + 90 * min).copy(channelId = "3"),
        )
        assertEquals("a", recordingOn(list, "1"))
        assertNull(recordingOn(list, "2"))   // ended by itself, or stopped elsewhere
        assertNull(recordingOn(list, "3"))   // booked, not started yet
        assertNull(recordingOn(list, "9"))
    }

    private val server = "http://127.0.0.1:8983/proxy/recording/r/index.m3u8"
    private val copy = "content://media/external/downloads/42"

    @Test fun `Solo plays a recording from its Downloads copy, the remote app from the server`() {
        assertEquals(copy, recordingPlayUrl(isSolo = true, copy = copy, serverUrl = server))
        assertEquals(server, recordingPlayUrl(isSolo = true, copy = null, serverUrl = server))   // not saved to Downloads yet
        assertEquals(server, recordingPlayUrl(isSolo = false, copy = copy, serverUrl = server))
    }

    @Test fun `Solo keeps one copy - the private files go once it's in Downloads, and deleting it deletes that copy`() {
        assertEquals(listOf("/data/recordings/x.ts", "/data/recordings/x.ts.index"), privateFilesAfterPublish("/data/recordings/x.ts"))
        assertEquals(copy, copyToDelete(isSolo = true, copy = copy))
        assertNull(copyToDelete(isSolo = true, copy = null))
        assertNull(copyToDelete(isSolo = false, copy = copy))
    }

    @Test fun `says who stopped someone else's recording, or cancelled their booking`() {
        assertEquals("Recorded 31 Oct · 20 min · 200 MB · Stopped by Bea",
            recordingLabel(rec(status = "done", startAt = now - 120 * min, endAt = now + 60 * min, endedAt = now - 100 * min, bytes = 200 * mb).copy(stoppedBy = "Bea"), now, utc))
        assertEquals("Cancelled by Bea", recordingLabel(rec(status = "cancelled", startAt = now, endAt = now + min).copy(stoppedBy = "Bea"), now, utc))
    }

    @Test fun `a booking someone else cancelled is listed with the recorded ones, one its owner cancelled is not`() {
        val g = groupRecordings(listOf(rec("a", "cancelled", now, now + min).copy(stoppedBy = "Bea"), rec("b", "cancelled", now, now + min)))
        assertEquals(listOf("a"), g.done.map { it.id })
    }

    @Test fun `a list asked for before the switch changed is dropped`() {
        assertTrue(keepRecordingsResult(asked = true, current = true))
        assertTrue(keepRecordingsResult(asked = false, current = false))
        assertFalse(keepRecordingsResult(asked = false, current = true))
        assertFalse(keepRecordingsResult(asked = true, current = false))
    }

    @Test fun `Solo saves only its own recordings to Downloads, never another viewer's`() {
        val done = rec("d", "done", now - 60 * min, now - min).copy(filePath = "/data/recordings/a.ts", bytes = mb)
        val list = listOf(done.copy(id = "mine", mine = true), done.copy(id = "theirs", mine = false))
        assertEquals(listOf("mine"), ownRecordings(list).map { it.id })
        assertEquals(listOf("mine"), recordingsToPublish(ownRecordings(list), emptySet()).map { it.id })
    }

    @Test fun `the server's recording link names this device's viewer, for its filters`() {
        assertEquals("http://h:1/k/t/proxy/recording/a%20b/index.m3u8?viewer=view_1", recordingServerUrl("http://h:1/k/t", "a b", "view_1"))
        assertEquals("http://h:1/proxy/recording/r/index.m3u8", recordingServerUrl("http://h:1", "r", null))   // Solo: no viewer of its own
    }

    @Test fun `knows a guide entry that stands for no programme`() {
        assertTrue(isGuidePlaceholder("No information available"))
        assertTrue(isGuidePlaceholder("no data"))
        assertTrue(isGuidePlaceholder("  "))
        assertFalse(isGuidePlaceholder("The Office"))
        assertFalse(isGuidePlaceholder("Nothing But Trailers"))
    }

    @Test fun `record a time starts at the half hour picked, or now once that half hour has begun`() {
        val t = { h: Int, m: Int -> now + ((h - 18) * 60 + m) * min }   // 31 Oct, UTC
        assertEquals(t(21, 0), timedStart(t(21, 10), t(20, 5), utc))
        assertEquals(t(21, 30), timedStart(t(21, 40), t(20, 5), utc))
        assertEquals(t(20, 25), timedStart(t(20, 5), t(20, 25) + 30_000, utc))   // on now: from now, to the minute
        assertEquals(t(20, 40), timedStart(t(18, 10), t(20, 40), utc))
        assertEquals("Today 21:00", timedLabel(t(21, 0), now, utc))
        assertEquals("Tomorrow 00:30", timedLabel(t(24, 30), now, utc))
    }

    @Test fun `record a time books a start and end, titled after the channel unless named`() {
        assertEquals(TimedBooking("HBO 2", now + 60 * min, now + 120 * min), timedBooking(now + 60 * min, now + 120 * min, "", "HBO 2", now))
        assertEquals("Movie night", timedBooking(now + 60 * min, now + 120 * min, " Movie night ", "HBO 2", now).title)
        assertEquals("It has to end after it starts.", timedBooking(now, now, "", "HBO 2", now - min).error)
        assertEquals("That time has already passed.", timedBooking(now - 120 * min, now - 60 * min, "", "HBO 2", now).error)
        assertEquals("A recording can be at most 12 hours.", timedBooking(now, now + 13 * 60 * min, "", "HBO 2", now).error)
    }
}
