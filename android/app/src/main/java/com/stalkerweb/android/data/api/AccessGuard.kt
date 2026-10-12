package com.stalkerweb.android.data.api

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/** Where the guard keeps a rejected key across restarts (AppPrefs). Null: not rejected. */
interface AccessStore {
    var rejectedMessage: String?
}

/**
 * Keeps the app from locking itself out of the server. Every request carries
 * the access key, and the server counts each wrong one toward a lockout that
 * doubles each time — so a key changed on the server must cost one counted
 * try, not one per request:
 *  - until the server has accepted the key once ([verified]), requests go out
 *    one at a time (ApiClient), so a refusal is seen before the next is sent;
 *  - after a refusal ([blocked], kept across restarts) nothing reaches the
 *    server: requests are answered here, until Setup saves a key ([reset]).
 */
class AccessGuard(private val store: AccessStore) {
    @Volatile var verified = false
        private set

    /** Held while an unverified request is in flight. */
    val lock = Any()

    val blocked: Boolean get() = store.rejectedMessage != null
    val message: String? get() = store.rejectedMessage

    /** Notes a server answer; returns the app event it means, if any (a refusal only the first time). */
    fun onResponse(code: Int, body: String?): AppEvent? {
        val event = appEventFor(code, body)
        if (event is AppEvent.AccessProblem) {
            val first = store.rejectedMessage == null
            store.rejectedMessage = event.message
            return if (first) event else null
        }
        // Past the access gate: the key is good (whatever the route answered).
        if (code !in KEY_REFUSALS) verified = true
        return event
    }

    /** A key was saved in Setup: try again. */
    fun reset() {
        store.rejectedMessage = null
        verified = false
    }

    private companion object { val KEY_REFUSALS = setOf(401, 403, 429) }
}

/** Whether [url] is the StalkerWeb server itself — only it gets the key, the viewer and the guard. */
fun sameServer(url: HttpUrl, serverUrl: String?): Boolean {
    val server = serverUrl?.toHttpUrlOrNull() ?: return false
    return url.scheme == server.scheme && url.host == server.host && url.port == server.port
}

/** The answer for a request the guard keeps back: a 401 as the server's access gate would send it. */
fun refusedResponse(request: Request, message: String?): Response {
    val text = (message ?: "Access key required.").replace("\\", "\\\\").replace("\"", "\\\"")
    return Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(401)
        .message("Access key refused")
        .body("""{"error":"$text","accessRequired":true}""".toResponseBody("application/json".toMediaType()))
        .build()
}
