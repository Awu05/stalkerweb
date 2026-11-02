package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.StatusResponse
import com.stalkerweb.android.data.api.parseErrorBody
import java.net.SocketTimeoutException

// Asleep: the server's idle timeout dropped the portal session, and the next
// real use — the channel list's own request — reconnects it to the last portal
// that worked (backend lib/portalSession.js). The app's status checks never
// wake it, so the idle disconnect still happens. Mirrors frontend/src/lib/connection.js.

/** Connected, or asleep (the next use reconnects): the portal's pages are open. */
fun portalUsable(status: StatusResponse?): Boolean = status?.connected == true || status?.asleep == true

/** At startup, the Portal screen only when the server has no portal to use; no answer at all leaves it alone. */
fun startupOpensPortal(status: StatusResponse?): Boolean = status != null && !portalUsable(status)

/** Why the server's wake failed, from a 503's body (backend middleware/session.js); null when it wasn't that. */
fun wakeErrorOf(body: String?): String? = parseErrorBody(body).wakeError?.takeIf { it.isNotBlank() }

/** How many times the channel list asks again when the server is slow to reconnect (each ask waits out the read timeout). */
const val WAKE_LOAD_RETRIES = 3

/** Whether a failed load should ask again: the request timed out — the server still reconnecting, the next ask joins it. */
fun retriesWhileWaking(e: Throwable, attempt: Int): Boolean = e is SocketTimeoutException && attempt < WAKE_LOAD_RETRIES
