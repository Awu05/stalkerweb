package com.stalkerweb.android.data.repo

import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.api.RecordNowRequest
import com.stalkerweb.android.data.api.ScheduleRecordingRequest
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.solo.SoloServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Live TV recordings, made by the server (backend routes/recordings.js): it
 * records with the app closed. This viewer's own, as the web lists them.
 */
class RecordingsRepository(private val apis: ApiProvider, private val prefs: AppPrefs) {

    suspend fun list(): List<Recording> = apis.get().getRecordings().recordings.also { seen(it) }

    // Told every list the app reads: Solo saves finished recordings to the
    // Downloads folder from it (DownloadPublisher).
    @Volatile var onList: ((List<Recording>) -> Unit)? = null

    // The recordings already saved to the Downloads folder, for the screen to say so.
    private val _published = MutableStateFlow(prefs.publishedRecordings)
    val published: StateFlow<Set<String>> = _published.asStateFlow()

    /** [id] has been copied to the Downloads folder (or let go: goneKey). */
    @Synchronized fun markPublished(id: String) {
        prefs.publishedRecordings = prefs.publishedRecordings + id
        _published.value = prefs.publishedRecordings
    }

    /** A guide programme booked (times in ms; the server adds the padding). A clash past the limit fails with why. */
    suspend fun schedule(channelId: String, channelName: String, title: String, startAt: Long, endAt: Long): Recording =
        apis.get().scheduleRecording(ScheduleRecordingRequest(channelId, channelName, title, startAt, endAt)).also { watch() }

    /**
     * The channel recorded from now until [endAt] (null: until stopped). With
     * the provider's streams in use it fails with ApiError.TakesStream: ask,
     * then send again with [force].
     */
    suspend fun recordNow(channelId: String, channelName: String, title: String, endAt: Long?, force: Boolean = false): Recording =
        apis.get().recordNow(RecordNowRequest(channelId, channelName, title, endAt, force)).also { watch() }

    /** Stops one (what it has is kept), or cancels one not started. */
    suspend fun stop(id: String) { apis.get().stopRecording(id) }

    /** Stopped if it's running, then deleted with its file (Solo: a copy in Downloads stays). */
    suspend fun delete(id: String) { apis.get().deleteRecording(id) }

    private fun seen(list: List<Recording>) {
        onList?.invoke(list)
        if (recordingNeedsServer(list, System.currentTimeMillis())) watch()
    }

    // Solo: the server does the recording, so it's kept up (SoloServer.hold)
    // while one records or is about to — wherever it was started from,
    // whatever screen is open. Not in the remote apps (followsDownloads).
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var watcher: Job? = null

    /** Follows the recordings until none is recording or about to, holding the server meanwhile. */
    @Synchronized fun watch() {
        if (!followsDownloads(BuildConfig.IS_SOLO) || watcher?.isActive == true) return
        watcher = scope.launch {
            SoloServer.hold(SoloHold.RECORDING)
            try { followUntilIdle() } finally { SoloServer.release(SoloHold.RECORDING) }
        }
    }

    private suspend fun followUntilIdle() {
        var misses = 0
        while (true) {
            val list = runCatching { apis.get().getRecordings().recordings }.getOrNull()
            list?.let { onList?.invoke(it) }
            if (list != null && !recordingNeedsServer(list, System.currentTimeMillis())) return
            // The server not answering for about two minutes: let go, it isn't recording.
            misses = if (list == null) misses + 1 else 0
            if (misses >= 12) return
            delay(10_000)
        }
    }
}
