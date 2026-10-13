package com.stalkerweb.android

import android.net.Uri

sealed class Screen(val route: String) {
    object Setup : Screen("setup?message={message}") {
        fun go(message: String? = null): String = "setup?message=${Uri.encode(message ?: "")}"
    }
    object Viewers : Screen("viewers?required={required}") {
        fun go(required: Boolean): String = "viewers?required=$required"
    }
    object Shell : Screen("shell")
    object Portal   : Screen("portal")
    object Player   : Screen("player/{channelId}/{channelName}") {
        fun go(channelId: String, channelName: String): String {
            val encodedName = Uri.encode(channelName)
            return "player/$channelId/$encodedName"
        }
    }
    object VodPlayer : Screen(
        "vodplayer?videoId={videoId}&cmd={cmd}&series={series}&seasonId={seasonId}&episodeId={episodeId}&title={title}"
    ) {
        fun go(
            videoId: String,
            cmd: String = "",
            series: String = "",
            seasonId: String = "",
            episodeId: String = "",
            title: String = "",
        ): String {
            fun e(s: String) = Uri.encode(s)
            return "vodplayer?videoId=${e(videoId)}&cmd=${e(cmd)}&series=${e(series)}" +
                "&seasonId=${e(seasonId)}&episodeId=${e(episodeId)}&title=${e(title)}"
        }
    }
}
