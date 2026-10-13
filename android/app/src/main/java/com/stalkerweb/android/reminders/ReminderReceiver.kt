package com.stalkerweb.android.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.stalkerweb.android.MainActivity
import com.stalkerweb.android.StalkerWebApp

/** A guide reminder came due: "Starting now: <title> on <channel>"; tapping it opens that channel. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val channelId = intent.getStringExtra(EXTRA_CHANNEL_ID) ?: return
        val channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        (context.applicationContext as? StalkerWebApp)?.container?.reminders?.fired(id)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Guide reminders", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val open = PendingIntent.getActivity(
            context, id.hashCode(),
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_CHANNEL_ID, channelId)
                .putExtra(EXTRA_CHANNEL_NAME, channelName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            // Not the adaptive launcher icon: as a small icon it crashes Android 8.0 and is a blank square elsewhere.
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("Starting now: $title")
            .setContentText(channelName)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val allowed = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (allowed) runCatching { NotificationManagerCompat.from(context).notify(id.hashCode(), notification) }
    }

    companion object {
        const val CHANNEL = "stalkerweb_reminders"
        const val EXTRA_ID = "reminderId"
        const val EXTRA_CHANNEL_ID = "channelId"
        const val EXTRA_CHANNEL_NAME = "channelName"
        const val EXTRA_TITLE = "title"
    }
}
