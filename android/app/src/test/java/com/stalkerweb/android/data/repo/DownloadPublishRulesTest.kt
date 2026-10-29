package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.DownloadJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DownloadPublishRulesTest {
    private fun job(id: String, status: String, path: String?) = DownloadJob(id = id, status = status, filePath = path)

    @Test fun `publishes each finished download once`() {
        val jobs = listOf(job("a", "done", "/d/dl/Heat (1995).ts"), job("b", "downloading", null), job("c", "done", "/d/dl/x.mp4"))
        assertEquals(listOf("a"), toPublish(jobs, published = setOf("c")).map { it.id })
    }

    @Test fun `names and types for the Downloads folder`() {
        assertEquals("Heat (1995).ts", publicName(job("a", "done", "/d/dl/Heat (1995).ts")))
        assertEquals("A_B.mp4", publicName(job("a", "done", "/d/dl/A:B.mp4")))
        assertEquals("video/mp2t", mimeOf("x.ts"))
        assertEquals("video/mp4", mimeOf("x.MP4"))
        assertEquals("video/x-matroska", mimeOf("x.mkv"))
        assertEquals("application/octet-stream", mimeOf("x.avi"))
    }

    @Test fun `only files inside the download folder may be published`() {
        val dir = File("/d/dl")
        assertTrue(isInside(dir, File("/d/dl/x.ts")))
        assertFalse(isInside(dir, File("/d/dl/../data/solo-server.properties")))
        assertFalse(isInside(dir, File("/d/dl2/x.ts")))
        assertFalse(isInside(dir, File("/d/dl")))
    }

    @Test fun `a download whose file is gone is not looked at again`() {
        val jobs = listOf(job("a", "done", "/d/dl/x.ts"))
        assertEquals(emptyList<String>(), toPublish(jobs, setOf(goneKey("a"))).map { it.id })
        assertEquals("Done · 1 MB", doneLabel(jobs[0], true, setOf(goneKey("a")), "1 MB"))
    }

    @Test fun `a finished download says where it was saved, in Solo only`() {
        val j = job("a", "done", "/d/dl/x.ts")
        assertEquals("Saved to Downloads/StalkerWeb · 1 MB", doneLabel(j, true, setOf("a"), "1 MB"))
        assertEquals("Done · 1 MB · not saved to Downloads yet", doneLabel(j, true, emptySet(), "1 MB"))
        assertEquals("Done · 1 MB", doneLabel(j, false, setOf("a"), "1 MB"))
    }

    private val now = 10L * 24 * 60 * 60_000
    private fun file(name: String, ageMs: Long = 60 * 60_000, isFile: Boolean = true, isLink: Boolean = false) =
        FolderFile(name, isFile, isLink, now - ageMs)

    @Test fun `saves the finished files no job lists, not ones in use`() {
        val files = listOf(
            file("Heat (1995).ts"),                 // left from before the server restarted
            file("Listed.mp4"),                     // a job's: saved through the job
            file("Going.ts.part"),                  // still being written, or cut short
            file("Just done.mp4", ageMs = 30_000),  // finished a moment ago: maybe not in the list read yet
            file("link.ts", isLink = true),
            file("folder", isFile = false),
        )
        val jobs = listOf(job("a", "done", "/data/user/0/app/files/downloads/Listed.mp4"), job("b", "downloading", null))
        assertEquals(listOf("Heat (1995).ts"), orphansToPublish(files, jobs, now).map { it.name })
        assertEquals(listOf("Heat (1995).ts", "Listed.mp4"), orphansToPublish(files.take(2), emptyList(), now).map { it.name })
    }

    @Test fun `deletes part files older than a day, only while nothing downloads`() {
        val files = listOf(
            file("Old.ts.part", ageMs = STALE_PART_MS + 1),
            file("New.ts.part", ageMs = STALE_PART_MS - 1),
            file("Old.ts", ageMs = STALE_PART_MS + 1),
            file("Linked.ts.part", ageMs = STALE_PART_MS + 1, isLink = true),
        )
        assertEquals(listOf("Old.ts.part"), stalePartsToDelete(files, listOf(job("a", "done", "/d/x.ts")), now).map { it.name })
        assertEquals(emptyList<FolderFile>(), stalePartsToDelete(files, listOf(job("b", "queued", null)), now))
        assertEquals(emptyList<FolderFile>(), stalePartsToDelete(files, listOf(job("b", "downloading", null)), now))
    }

    @Test fun `an orphan's name in the Downloads folder is its own, cleaned`() {
        assertEquals("Heat (1995).ts", publicFileName("Heat (1995).ts"))
        assertEquals("A_B.mp4", publicFileName("A:B.mp4"))
        assertEquals("download", publicFileName("  "))
    }

    @Test fun `a name of only dots, or ending in dots or spaces, becomes a safe one`() {
        assertEquals("download", publicFileName(".."))
        assertEquals("download", publicFileName("."))
        assertEquals("download", publicFileName(" . . "))
        assertEquals("Heat", publicFileName("Heat. . "))
        assertEquals("Heat.ts", publicFileName("Heat.ts..."))
        assertEquals(".hidden.ts", publicFileName(".hidden.ts"))
    }

    @Test fun `a done download with a blank file path is not published`() {
        val jobs = listOf(job("a", "done", ""), job("b", "done", "  "), job("c", "done", null), job("d", "done", "/d/dl/x.ts"))
        assertEquals(listOf("d"), toPublish(jobs, emptySet()).map { it.id })
    }

    @Test fun `an opened download is copied only when it's a regular file inside the folder`() {
        val dir = "/data/user/0/app/files/downloads"
        assertTrue(openedInside(dir, "$dir/Heat.ts", isRegular = true))
        assertFalse(openedInside(dir, "$dir/Heat.ts", isRegular = false))            // a folder, a pipe
        assertFalse(openedInside(dir, "/data/user/0/app/files/data/config.json", isRegular = true))   // a link that pointed out
        assertFalse(openedInside(dir, "${dir}2/x.ts", isRegular = true))            // a folder next to it
        assertFalse(openedInside(dir, dir, isRegular = true))
    }
}
