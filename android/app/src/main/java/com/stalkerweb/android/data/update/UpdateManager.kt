package com.stalkerweb.android.data.update

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File

data class ReleaseInfo(val tagName: String, val version: String, val apkUrl: String)

class UpdateManager(private val context: Context) {

    private val client = OkHttpClient()
    private val prefs  = context.getSharedPreferences("stalkerweb_update", Context.MODE_PRIVATE)

    /** The latest GitHub release, and whether it has a newer APK for this build (mobile or TV). */
    suspend fun latest(): UpdateCheck = withContext(Dispatchers.IO) {
        runCatching {
            val req  = Request.Builder()
                .url("https://api.github.com/repos/${com.stalkerweb.android.BuildConfig.GITHUB_REPO}/releases/latest")
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "StalkerWeb-Android/${com.stalkerweb.android.BuildConfig.VERSION_NAME}")
                .build()
            val response = client.newCall(req).execute()
            val body = response.use { r ->
                if (!r.isSuccessful) {
                    Log.w("UpdateManager", "Check failed: ${r.code} ${r.message}")
                    return@withContext UpdateCheck.Failed
                }
                r.body?.string()
            } ?: return@withContext UpdateCheck.Failed
            val json    = JSONObject(body)
            val tagName = json.getString("tag_name")
            val version = tagName.trimStart('v')
            if (!isNewerVersion(version, com.stalkerweb.android.BuildConfig.VERSION_NAME)) {
                Log.d("UpdateManager", "Current version (${com.stalkerweb.android.BuildConfig.VERSION_NAME}) is up to date with $version")
                return@withContext UpdateCheck.UpToDate(version)
            }
            val assets = json.getJSONArray("assets")
            val named = (0 until assets.length()).map { i ->
                val asset = assets.getJSONObject(i)
                asset.getString("name") to asset.getString("browser_download_url")
            }
            val url = apkFor(named, com.stalkerweb.android.BuildConfig.IS_TV)
                ?: return@withContext UpdateCheck.NoApk(version)
            Log.i("UpdateManager", "New version found: $version")
            UpdateCheck.Found(ReleaseInfo(tagName, version, url))
        }.onFailure {
            Log.e("UpdateManager", "Update check error: ${it.message}", it)
        }.getOrDefault(UpdateCheck.Failed)
    }

    suspend fun downloadApk(release: ReleaseInfo, onProgress: (Float) -> Unit): File = withContext(Dispatchers.IO) {
        val req      = Request.Builder()
            .url(release.apkUrl)
            .header("User-Agent", "StalkerWeb-Android/${com.stalkerweb.android.BuildConfig.VERSION_NAME}")
            .build()
        val response = client.newCall(req).execute()
        // A 403 (rate limit) or 404 still carries a body — the error page — so
        // checking only for null would happily write HTML into update.apk and
        // then offer it as an installable update on every launch until some
        // other build replaces it.
        if (!response.isSuccessful) {
            val code = response.code
            response.close()
            throw Exception("Download failed: HTTP $code")
        }
        val body     = response.body ?: throw Exception("Empty response body")
        val total    = body.contentLength()
        val dir      = File(context.externalCacheDir ?: context.cacheDir, "apk_downloads").also { it.mkdirs() }
        val file     = File(dir, "update.apk")
        var received = 0L

        val nm = NotificationManagerCompat.from(context)
        val progressBuilder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading update…")
            .setOngoing(true)
            .setSilent(true)
            .setProgress(100, 0, total <= 0)

        body.byteStream().use { input ->
            file.outputStream().use { output ->
                val buf = ByteArray(8 * 1024)
                var n: Int
                var lastNotifiedPct = -1
                while (input.read(buf).also { n = it } != -1) {
                    output.write(buf, 0, n)
                    received += n
                    if (total > 0) {
                        val pct = (received * 100 / total).toInt()
                        onProgress(received.toFloat() / total)
                        // Throttle notification updates to every 5 %
                        if (pct >= lastNotifiedPct + 5) {
                            lastNotifiedPct = pct
                            runCatching {
                                nm.notify(NOTIF_PROGRESS, progressBuilder
                                    .setProgress(100, pct, false)
                                    .setContentText("$pct%")
                                    .build())
                            }
                        }
                    }
                }
            }
        }

        // Remember which version this APK is for, so once it's installed we can
        // tell the cached file is stale and stop offering it as an update.
        prefs.edit().putString(KEY_PENDING_VERSION, release.version).apply()

        // Cancel progress notification and post "ready to install" notification
        nm.cancel(NOTIF_PROGRESS)

        val launchIntent = context.packageManager
            .getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(
            context, 0, launchIntent ?: Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        runCatching {
            nm.notify(NOTIF_READY, NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Update ready to install")
                .setContentText("Tap to open the app and install")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build())
        }

        file.setReadable(true, false)
        file
    }

    /**
     * Returns the cached APK file if a download is still pending install — i.e. the
     * file exists on disk (survives process death) AND its version is newer than the
     * currently installed app. Once the update has been installed, the cached APK is
     * stale, so we delete it and return null instead of forever showing "update ready".
     */
    fun cachedApk(): File? {
        val dir  = File(context.externalCacheDir ?: context.cacheDir, "apk_downloads")
        val file = File(dir, "update.apk")
        if (!file.exists() || file.length() <= 0) return null

        val pending = prefs.getString(KEY_PENDING_VERSION, null)
        if (pending != null && isNewerVersion(pending, com.stalkerweb.android.BuildConfig.VERSION_NAME)) {
            return file
        }
        // Already installed (or unknown version) → clean up the stale download.
        file.delete()
        prefs.edit().remove(KEY_PENDING_VERSION).apply()
        return null
    }

    companion object {
        const val CHANNEL_ID     = "stalkerweb_updates"
        const val CHANNEL_NAME   = "App updates"
        private const val NOTIF_PROGRESS = 1001
        private const val NOTIF_READY    = 1002
        private const val KEY_PENDING_VERSION = "pending_update_version"
    }
}
