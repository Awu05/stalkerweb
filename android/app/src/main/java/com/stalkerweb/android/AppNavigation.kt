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
    object VodPlayer : Screen("vodplayer?params={params}") {
        fun go(params: com.stalkerweb.android.data.repo.PlayerParams): String =
            "vodplayer?params=${Uri.encode(params.toQuery())}"
    }
}
