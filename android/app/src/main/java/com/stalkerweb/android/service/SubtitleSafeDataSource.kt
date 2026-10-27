package com.stalkerweb.android.service

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException

/**
 * The player's data source, with one difference: an online subtitle file
 * (the server's /api/vod/subtitles/file/…) that can't be fetched reads as an
 * empty subtitle file instead of failing. Added beside a movie, a failed file
 * would otherwise stop the movie itself; this way the movie plays on, without
 * subtitles. (The app fetches the file before adding it, and says when it
 * couldn't — VodPlayerViewModel.)
 */
@OptIn(UnstableApi::class)
class SubtitleSafeDataSource(private val upstream: DataSource) : DataSource {
    private var current: DataSource = upstream

    class Factory(private val upstream: DataSource.Factory) : DataSource.Factory {
        override fun createDataSource(): DataSource = SubtitleSafeDataSource(upstream.createDataSource())
    }

    override fun addTransferListener(transferListener: TransferListener) = upstream.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        current = upstream
        if (!dataSpec.uri.path.orEmpty().contains(SUBTITLE_FILES)) return upstream.open(dataSpec)
        return try {
            upstream.open(dataSpec)
        } catch (e: IOException) {
            runCatching { upstream.close() }
            current = ByteArrayDataSource(EMPTY_VTT)
            current.open(dataSpec.buildUpon().setPosition(0).build())
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = current.read(buffer, offset, length)

    override fun getUri(): Uri? = current.uri ?: upstream.uri

    override fun getResponseHeaders(): Map<String, List<String>> = current.responseHeaders

    override fun close() = current.close()

    private companion object {
        const val SUBTITLE_FILES = "/api/vod/subtitles/file/"
        val EMPTY_VTT = "WEBVTT\n\n".toByteArray()
    }
}
