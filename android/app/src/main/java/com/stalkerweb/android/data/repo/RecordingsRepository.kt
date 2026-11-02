package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.background
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.api.RecordingsResponse
import com.stalkerweb.android.data.api.RecordNowRequest
import com.stalkerweb.android.data.api.ScheduleRecordingRequest
import com.stalkerweb.android.data.prefs.AppPrefs
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

    /** This viewer's recordings — or, [everyone], every viewer's (each with its viewerName). [background]: asked by a timer or loop (ApiClient.kt Background). */
    suspend fun list(everyone: Boolean = false, background: Boolean = false): List<Recording> = listing(everyone, background).recordings

    /** [list], with what the recordings take on the server's disk. */
    suspend fun listing(everyone: Boolean = false, background: Boolean = false): RecordingsResponse =
        apis.get().getRecordings(if (everyone) "1" else null, background(background)).also { seen(it.recordings) }

    // Told this device's own recordings from every list the app reads (never
    // another viewer's, from Everyone's recordings): Solo saves finished ones
    // to the Downloads folder from it (DownloadPublisher).
    @Volatile var onList: ((List<Recording>) -> Unit)? = null

    // The recordings already saved to the Downloads folder, for the screen to say so.
    private val _published = MutableStateFlow(prefs.publishedRecordings)
    val published: StateFlow<Set<String>> = _published.asStateFlow()

    /** [id] has been copied to the Downloads folder (or let go: goneKey). */
    @Synchronized fun markPublished(id: String) {
        prefs.publishedRecordings = prefs.publishedRecordings + id
        _published.value = prefs.publishedRecordings
    }

    /**
     * A guide programme booked (times in ms; the server adds the padding). A
     * clash past the limit fails with why; one starting within 5 minutes with
     * the provider's streams in use fails with ApiError.TakesStream: ask, then
     * send again with [force].
     */
    suspend fun schedule(channelId: String, channelName: String, title: String, startAt: Long, endAt: Long, force: Boolean = false): Recording =
        apis.get().scheduleRecording(ScheduleRecordingRequest(channelId, channelName, title, startAt, endAt, force)).also { watch() }

    /**
     * The channel recorded from now until [endAt] (null: until stopped). With
     * the provider's streams in use it fails with ApiError.TakesStream: ask,
     * then send again with [force].
     */
    suspend fun recordNow(channelId: String, channelName: String, title: String, endAt: Long?, force: Boolean = false): Recording =
        apis.get().recordNow(RecordNowRequest(channelId, channelName, title, endAt, force)).also { watch() }

    /** Stops one (what it has is kept), or cancels one not started. */
    suspend fun stop(id: String) { apis.get().stopRecording(id) }

    // Solo: deletes a recording's copy in Downloads/StalkerWeb (DownloadPublisher) — the app owns it.
    @Volatile var onDeleteCopy: ((String) -> Unit)? = null

    /** Stopped if it's running, then deleted with its file — in Solo, its copy in Downloads too (the only copy). */
    suspend fun delete(id: String) {
        apis.get().deleteRecording(id)
        copyToDelete(BuildConfig.IS_SOLO, prefs.recordingCopy(id))?.let { uri -> runCatching { onDeleteCopy?.invoke(uri) } }
        prefs.setRecordingCopy(id, null)
    }

    /** Solo: where recording [id] was saved in Downloads (a content:// URI), or null. */
    fun copyOf(id: String): String? = prefs.recordingCopy(id)

    /** Solo: recording [id] is saved in Downloads at [uri] — the app plays it from there. */
    fun keepCopy(id: String, uri: String) = prefs.setRecordingCopy(id, uri)

    private fun seen(list: List<Recording>) {
        onList?.invoke(ownRecordings(list))
        if (recordingNeedsServer(list, System.currentTimeMillis())) watch()
    }

    // Solo: while one records or is about to, the list is followed, so each
    // is saved to Downloads as it finishes (onList). Keeping the server up for
    // them is the server's own doing (SoloServerService, recordingPlan) — not
    // this app's, which may be closed. Not in the remote apps (followsDownloads).
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var watcher: Job? = null

    /** Follows the recordings until none is recording or about to. */
    @Synchronized fun watch() {
        if (!followsDownloads(BuildConfig.IS_SOLO) || watcher?.isActive == true) return
        watcher = scope.launch { followUntilIdle() }
    }

    private suspend fun followUntilIdle() {
        var misses = 0
        while (true) {
            val list = runCatching { apis.get().getRecordings(background = background(true)).recordings }.getOrNull()
            list?.let { onList?.invoke(ownRecordings(it)) }
            if (list != null && !recordingNeedsServer(list, System.currentTimeMillis())) return
            // The server not answering for about two minutes: let go, it isn't recording.
            misses = if (list == null) misses + 1 else 0
            if (misses >= 12) return
            delay(10_000)
        }
    }
}
