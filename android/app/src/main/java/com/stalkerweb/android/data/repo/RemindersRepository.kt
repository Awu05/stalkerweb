package com.stalkerweb.android.data.repo

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.reminders.ReminderReceiver
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** "Remind me" for guide programmes — kept on this device (as on the web), a notification a minute before. */
class RemindersRepository(private val context: Context, private val prefs: AppPrefs) {
    private val _list = MutableStateFlow(ReminderRules.upcoming(prefs.reminders, System.currentTimeMillis()))
    val list: StateFlow<List<Reminder>> = _list.asStateFlow()
    private val _due = MutableSharedFlow<Reminder>(extraBufferCapacity = 4)
    /** A reminder came due while the app is running: shown in the app too (TVs show no heads-up notifications). */
    val due: SharedFlow<Reminder> = _due.asSharedFlow()

    // Alarms don't survive a reboot or a force-stop: set them again whenever the app starts (BootReceiver starts it).
    init { _list.value.forEach { runCatching { schedule(it) } } }

    fun isSet(channelId: String, event: EpgEvent): Boolean = _list.value.any { it.id == "$channelId:${event.startTime}" }

    /** Sets or clears the reminder; returns true when set. A programme already on can't be set. */
    fun toggle(channelId: String, channelName: String, event: EpgEvent): Boolean {
        val r = ReminderRules.reminderFor(channelId, channelName, event)
        if (_list.value.any { it.id == r.id }) { remove(r.id); return false }
        if (!ReminderRules.isUpcoming(r, System.currentTimeMillis())) return false
        save(_list.value + r)
        schedule(r)
        return true
    }

    fun remove(id: String) {
        _list.value.firstOrNull { it.id == id }?.let(::cancel)
        save(_list.value.filter { it.id != id })
    }

    /** The alarm went off: it's no longer pending. */
    fun fired(id: String) {
        _list.value.firstOrNull { it.id == id }?.let { _due.tryEmit(it) }
        save(_list.value.filter { it.id != id })
    }

    private fun save(list: List<Reminder>) {
        prefs.reminders = list
        _list.value = list
    }

    private fun intent(r: Reminder) = PendingIntent.getBroadcast(
        context, r.id.hashCode(),
        Intent(context, ReminderReceiver::class.java)
            .putExtra(ReminderReceiver.EXTRA_ID, r.id)
            .putExtra(ReminderReceiver.EXTRA_CHANNEL_ID, r.channelId)
            .putExtra(ReminderReceiver.EXTRA_CHANNEL_NAME, r.channelName)
            .putExtra(ReminderReceiver.EXTRA_TITLE, r.title),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun schedule(r: Reminder) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        // Inexact (no exact-alarm permission needed): at most a few minutes late.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, ReminderRules.dueAtMs(r), intent(r))
    }

    private fun cancel(r: Reminder) {
        context.getSystemService(AlarmManager::class.java)?.cancel(intent(r))
    }
}
