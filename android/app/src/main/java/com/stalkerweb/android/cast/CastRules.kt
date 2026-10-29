package com.stalkerweb.android.cast

import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.api.CastLink
import com.stalkerweb.android.data.repo.castMessage

/**
 * The TV can't open the link: the server was reached as localhost — or, in
 * Solo, the device isn't on Wi-Fi. The message says which (castMessage).
 */
class UnreachableCastLink(isSolo: Boolean = BuildConfig.IS_SOLO) : Exception(castMessage(reachable = false, isSolo = isSolo))

/** What the TV is sent for a cast link from the server. */
fun castMediaOf(link: CastLink, title: String?, subtitle: String? = null, imageUrl: String? = null, startMs: Long = 0): CastMedia {
    if (!link.reachable) throw UnreachableCastLink()
    return CastMedia(link.url, link.contentType, link.live, title, subtitle, imageUrl, if (link.live) 0 else startMs.coerceAtLeast(0))
}

/**
 * Where the phone picks a movie up once casting ends: where the TV got to —
 * or nowhere (stay put) when it hadn't started, or was in its last 5%.
 */
fun resumeAfterCast(remotePositionMs: Long, durationMs: Long): Long? {
    if (remotePositionMs <= 0) return null
    if (durationMs > 0 && remotePositionMs >= durationMs * 0.95) return null
    return remotePositionMs
}
