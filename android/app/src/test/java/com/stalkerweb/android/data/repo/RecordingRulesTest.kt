package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Recording
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
}
