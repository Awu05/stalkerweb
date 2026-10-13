package com.stalkerweb.android.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.stalkerweb.android.StalkerWebApp

/** After a reboot: starting the app's data layer sets the pending reminders' alarms again (RemindersRepository). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        (context.applicationContext as? StalkerWebApp)?.container?.reminders
    }
}
