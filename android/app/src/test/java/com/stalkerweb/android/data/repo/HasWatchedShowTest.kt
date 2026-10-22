package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ProgressEntry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as the web's hasWatchedShow (seriesProgress.test.js). */
class HasWatchedShowTest {
    @Test fun `a show never started is not watched, one with any trace of it is`() {
        assertFalse(hasWatchedShow("200", emptyList(), emptyList(), emptyList(), emptyList()))
        assertFalse(hasWatchedShow("200", emptyList(), listOf(HistoryEntry(id = "300", key = "300:s1:e1")), emptyList(), listOf("2000:s1:e1")))
        assertTrue(hasWatchedShow("200", emptyList(), listOf(HistoryEntry(id = "200", key = "200:s1:e1")), emptyList(), emptyList()))
        assertTrue(hasWatchedShow("200", emptyList(), emptyList(), listOf(ProgressEntry("200:s2:e4")), emptyList()))
        assertTrue(hasWatchedShow("200", emptyList(), emptyList(), emptyList(), listOf("200:s1:e3")))
        assertTrue(hasWatchedShow("200", listOf("200"), emptyList(), emptyList(), emptyList()))
    }

    @Test fun `is the rule the Not watched filter uses too`() {
        org.junit.Assert.assertEquals(setOf("1", "2", "3", "4"),
            startedTitleIds(listOf("1"), listOf(HistoryEntry(id = "2")), listOf(ProgressEntry("3")), listOf("4:s1:e1")))
    }
}
