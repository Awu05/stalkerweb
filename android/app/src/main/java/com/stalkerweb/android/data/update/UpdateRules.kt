package com.stalkerweb.android.data.update

/**
 * Whether [remote] ("0.4.36", a "v" in front is fine) is a later version than
 * [current]. A pre-release ("0.4.36-rc.1") comes before its release and after
 * the one before it, as the release workflow tags them.
 */
fun isNewerVersion(remote: String, current: String): Boolean = compareVersions(remote, current) > 0

private fun compareVersions(a: String, b: String): Int {
    fun split(v: String): Pair<List<Int>, String?> {
        val s = v.trim().trimStart('v')
        val dash = s.indexOf('-')
        val core = if (dash >= 0) s.substring(0, dash) else s
        val pre = if (dash >= 0) s.substring(dash + 1) else null
        return core.split(".").map { it.toIntOrNull() ?: 0 } to pre
    }
    val (ac, ap) = split(a)
    val (bc, bp) = split(b)
    for (i in 0 until maxOf(ac.size, bc.size)) {
        val diff = ac.getOrElse(i) { 0 } - bc.getOrElse(i) { 0 }
        if (diff != 0) return diff
    }
    return when {
        ap == bp -> 0
        ap == null -> 1    // the release beats its own pre-releases
        bp == null -> -1
        else -> comparePre(ap, bp)
    }
}

/** "rc.2" after "rc.1", "rc.10" after "rc.9", "rc" after "beta". */
private fun comparePre(a: String, b: String): Int {
    val ap = a.split('.')
    val bp = b.split('.')
    for (i in 0 until maxOf(ap.size, bp.size)) {
        val x = ap.getOrNull(i) ?: return -1
        val y = bp.getOrNull(i) ?: return 1
        val xn = x.toIntOrNull()
        val yn = y.toIntOrNull()
        val c = if (xn != null && yn != null) xn.compareTo(yn) else x.compareTo(y)
        if (c != 0) return c
    }
    return 0
}

private val FORM = Regex("""-(tv|mobile)[-.]""", RegexOption.IGNORE_CASE)
private val SOLO_FORM = Regex("""-solo_(tv|mobile)[-.]""", RegexOption.IGNORE_CASE)

/**
 * The download URL of this build's APK among a release's assets (name to
 * URL): "stalkerweb-tv-v0.4.36.apk" for the TV build,
 * "stalkerweb-mobile-v0.4.36.apk" for the phone. The Solo app takes
 * "stalkerweb-solo_tv-…" / "stalkerweb-solo_mobile-…", which the server app's
 * rule never matches. Null when the release has none for it — the other
 * form's APK would install as a second app, not update this one.
 */
fun apkFor(assets: List<Pair<String, String>>, isTv: Boolean, isSolo: Boolean = false): String? {
    val want = if (isTv) "tv" else "mobile"
    val form = if (isSolo) SOLO_FORM else FORM
    return assets.firstOrNull { (name, _) ->
        name.endsWith(".apk", ignoreCase = true) && form.find(name)?.groupValues?.get(1)?.lowercase() == want
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
