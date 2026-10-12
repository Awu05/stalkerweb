package com.stalkerweb.android.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ApiErrorTest {
    @Test fun accessGateRefusalsAreAccessDenied() {
        val e = apiErrorFor(401, """{"error":"Access key required.","accessRequired":true}""")
        assertTrue(e is ApiError.AccessDenied)
        assertEquals("Access key required.", e.message)
    }

    @Test fun lockoutsKeepTheServersWait() {
        val e = apiErrorFor(429, """{"error":"Too many wrong access keys — try again in 30 minutes."}""")
        assertTrue(e is ApiError.LockedOut)
        assertEquals("Too many wrong access keys — try again in 30 minutes.", e.message)
    }

    @Test fun aDeletedViewerIsViewerGone() {
        assertTrue(apiErrorFor(409, """{"error":"This viewer was deleted.","viewerGone":true}""") is ApiError.ViewerGone)
    }

    @Test fun otherFailuresKeepTheServersMessage() {
        val e = apiErrorFor(500, """{"error":"The viewers could not be saved."}""")
        assertTrue(e is ApiError.Failed)
        assertEquals("The viewers could not be saved.", e.message)
        assertEquals("HTTP 502", apiErrorFor(502, "<html>bad gateway</html>").message)
        // A portal's own 401 (no accessRequired) is not an access-key problem.
        assertTrue(apiErrorFor(401, """{"error":"Portal refused the MAC"}""") is ApiError.Failed)
    }

    @Test fun networkFailuresAreUnreachable() {
        assertTrue(IOException("timeout").toApiError() is ApiError.Unreachable)
    }

    @Test fun onlyAccessAndViewerProblemsBecomeAppEvents() {
        assertEquals(AppEvent.ViewerGone, appEventFor(409, """{"viewerGone":true}"""))
        assertEquals(AppEvent.AccessProblem("Access key required."), appEventFor(401, """{"error":"Access key required.","accessRequired":true}"""))
        assertTrue(appEventFor(429, """{"error":"Too many"}""") is AppEvent.AccessProblem)
        assertNull(appEventFor(401, """{"error":"Portal refused the MAC"}"""))
        assertNull(appEventFor(500, null))
    }
}
