package com.stalkerweb.android.data.api

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessGuardTest {
    private class MemoryStore : AccessStore { override var rejectedMessage: String? = null }

    private val refused = """{"error":"Access key required.","accessRequired":true}"""

    @Test fun theFirstRefusalLatchesAndIsReportedOnce() {
        val store = MemoryStore()
        val guard = AccessGuard(store)
        assertEquals(AppEvent.AccessProblem("Access key required."), guard.onResponse(401, refused))
        assertTrue(guard.blocked)
        assertEquals("Access key required.", store.rejectedMessage)
        assertNull(guard.onResponse(401, refused))   // already latched: no second event
    }

    @Test fun aLockoutLatchesToo() {
        val guard = AccessGuard(MemoryStore())
        assertTrue(guard.onResponse(429, """{"error":"Too many wrong access keys — try again in 15 minutes.","accessRequired":false}""") is AppEvent.AccessProblem)
        assertTrue(guard.blocked)
    }

    @Test fun aConnectRateLimitDoesNotLatch() {
        val guard = AccessGuard(MemoryStore())
        assertNull(guard.onResponse(429, """{"error":"Too many connect attempts. Try again in 1 minute."}"""))
        assertTrue(!guard.blocked)
    }

    @Test fun anAcceptedKeyIsVerifiedAndOtherRefusalsDoNotLatch() {
        val guard = AccessGuard(MemoryStore())
        assertNull(guard.onResponse(401, """{"error":"Portal refused the MAC"}"""))
        assertFalse(guard.blocked)
        assertFalse(guard.verified)
        assertNull(guard.onResponse(200, null))
        assertTrue(guard.verified)
    }

    @Test fun aDeletedViewerIsPassedOnWithoutLatching() {
        val guard = AccessGuard(MemoryStore())
        assertEquals(AppEvent.ViewerGone, guard.onResponse(409, """{"viewerGone":true}"""))
        assertFalse(guard.blocked)
    }

    @Test fun aRejectionSurvivesARestartUntilReset() {
        val store = MemoryStore().apply { rejectedMessage = "Access key required." }
        val guard = AccessGuard(store)
        assertTrue(guard.blocked)
        guard.reset()
        assertFalse(guard.blocked)
        assertNull(store.rejectedMessage)
    }

    @Test fun headersAndTheGuardOnlyApplyToTheServerItself() {
        assertTrue(sameServer("http://192.168.1.5:8983/api/logos/render?url=x".toHttpUrl(), "http://192.168.1.5:8983"))
        assertFalse(sameServer("https://logos.example.com/hbo.png".toHttpUrl(), "http://192.168.1.5:8983"))
        assertFalse(sameServer("http://192.168.1.5:9000/x".toHttpUrl(), "http://192.168.1.5:8983"))
        assertFalse(sameServer("http://192.168.1.5:8983/x".toHttpUrl(), null))
    }

    @Test fun aRefusedRequestIsAnsweredLocallyAsAnAccessError() {
        val response = refusedResponse(Request.Builder().url("http://x/api/channels").build(), "Access key required.")
        assertEquals(401, response.code)
        assertTrue(apiErrorFor(response.code, response.body.string()) is ApiError.AccessDenied)
    }
}
