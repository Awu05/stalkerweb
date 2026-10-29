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
}
