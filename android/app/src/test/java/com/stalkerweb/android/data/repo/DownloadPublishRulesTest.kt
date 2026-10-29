package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.DownloadJob
import org.junit.Assert.assertEquals
import org.junit.Test

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
        assertEquals("video/*", mimeOf("x.avi"))
    }

    @Test fun `a finished download says where it was saved, in Solo only`() {
        val j = job("a", "done", "/d/dl/x.ts")
        assertEquals("Saved to Downloads/StalkerWeb · 1 MB", doneLabel(j, true, setOf("a"), "1 MB"))
        assertEquals("Done · 1 MB · not saved to Downloads yet", doneLabel(j, true, emptySet(), "1 MB"))
        assertEquals("Done · 1 MB", doneLabel(j, false, setOf("a"), "1 MB"))
    }
}
