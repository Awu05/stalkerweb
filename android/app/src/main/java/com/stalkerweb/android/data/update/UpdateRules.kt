package com.stalkerweb.android.data.update

/** Whether [remote] ("0.4.36", a "v" in front is fine) is a later version than [current]. */
fun isNewerVersion(remote: String, current: String): Boolean {
    val r = remote.trim().trimStart('v').split(".").map { it.toIntOrNull() ?: 0 }
    val c = current.trim().trimStart('v').split(".").map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(r.size, c.size)) {
        val diff = r.getOrElse(i) { 0 } - c.getOrElse(i) { 0 }
        if (diff != 0) return diff > 0
    }
    return false
}

private val FORM = Regex("""-(tv|mobile)[-.]""", RegexOption.IGNORE_CASE)

/**
 * The download URL of this build's APK among a release's assets (name to URL):
 * "stalkerweb-tv-v0.4.36.apk" for the TV build, "stalkerweb-mobile-v0.4.36.apk"
 * for the phone. Null when the release has none for it — the other form's APK
 * would install as a second app, not update this one.
 */
fun apkFor(assets: List<Pair<String, String>>, isTv: Boolean): String? {
    val want = if (isTv) "tv" else "mobile"
    return assets.firstOrNull { (name, _) ->
        name.endsWith(".apk", ignoreCase = true) && FORM.find(name)?.groupValues?.get(1)?.lowercase() == want
    }?.second
}

/** What a look at the latest release found. */
sealed class UpdateCheck {
    data class Found(val release: ReleaseInfo) : UpdateCheck()
    data class UpToDate(val version: String) : UpdateCheck()
    /** A newer release, but no APK in it for this build. */
    data class NoApk(val version: String) : UpdateCheck()
    object Failed : UpdateCheck()
}

/** The line Settings shows after a check by hand. */
fun checkMessage(check: UpdateCheck, current: String): String = when (check) {
    is UpdateCheck.Found -> "Version ${check.release.version} is available."
    is UpdateCheck.UpToDate -> "Up to date (version $current)."
    is UpdateCheck.NoApk -> "Version ${check.version} is out, but has no APK for this device yet."
    UpdateCheck.Failed -> "Couldn't check for updates. Try again later."
}
