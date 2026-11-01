package com.stalkerweb.android.solo

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * The alarm SoloServerService sets 15 minutes before a booked recording: it
 * starts the service again — Node with it, if Android had stopped it — which
 * then holds itself up for the recording (recordingPlan). In the foreground
 * when Android lets it; else as a plain start, which the service then moves
 * into the foreground itself if it may.
 */
class SoloAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val start = Intent(context, SoloServerService::class.java).setAction(SoloServerService.ACTION_RECORDING_SOON)
        val inForeground = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && runCatching {
            context.startForegroundService(Intent(start).putExtra(SoloServerService.EXTRA_FOREGROUND, true))
        }.isSuccess
        if (!inForeground) runCatching { context.startService(start) }
            .onFailure { Log.w(TAG, "couldn't start the server for a booked recording (${it.javaClass.simpleName})") }
    }

    companion object {
        private const val TAG = "SoloAlarm"

        /** The alarm's intent (the same each time, so a new alarm replaces the last). */
        fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, 0, Intent(context, SoloAlarmReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
