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

/**
 * "Remind me" for guide programmes — kept on this device (as on the web), a
 * notification a minute before. Each belongs to the portal it was set on: only
 * that portal's are listed, and only they notify.
 */
class RemindersRepository(private val context: Context, private val prefs: AppPrefs) {
    private var all = ReminderRules.upcoming(prefs.reminders, System.currentTimeMillis())
    private var portal: String? = prefs.activePortal
    private val _list = MutableStateFlow(ReminderRules.forPortal(all, portal))
    /** This portal's pending reminders. */
    val list: StateFlow<List<Reminder>> = _list.asStateFlow()
    private val _due = MutableSharedFlow<Reminder>(extraBufferCapacity = 4)
    /** A reminder came due while the app is running: shown in the app too (TVs show no heads-up notifications). */
    val due: SharedFlow<Reminder> = _due.asSharedFlow()

    // Alarms don't survive a reboot or a force-stop: set them again whenever the app starts (BootReceiver starts it).
    // Not one that is firing now (the app may be starting for it): it would go off a second time.
    init {
        val now = System.currentTimeMillis()
        all.filter { ReminderRules.needsAlarm(it, now) }.forEach { runCatching { schedule(it) } }
    }

    /** The portal now connected (ServerRepository status): its reminders are the ones shown. */
    fun setPortal(p: String?) {
        if (p == null || p == portal) return
        portal = p
        prefs.activePortal = p
        _list.value = ReminderRules.forPortal(all, p)
    }

    fun isSet(channelId: String, event: EpgEvent): Boolean = _list.value.any { it.id == "$channelId:${event.startTime}" }

    /** Sets or clears the reminder; returns true when set. A programme already on can't be set. */
    fun toggle(channelId: String, channelName: String, event: EpgEvent): Boolean {
        val r = ReminderRules.reminderFor(channelId, channelName, event, portal.orEmpty())
        if (_list.value.any { it.id == r.id }) { remove(r.id); return false }
        if (!ReminderRules.isUpcoming(r, System.currentTimeMillis())) return false
        save(all.filter { it.id != r.id } + r)
        schedule(r)
        return true
    }

    fun remove(id: String) {
        all.firstOrNull { it.id == id }?.let(::cancel)
        save(all.filter { it.id != id })
    }

    /** The alarm went off: no longer pending. True when it should notify (still pending, and on this portal). */
    fun fired(id: String): Boolean {
        val r = all.firstOrNull { it.id == id } ?: return false
        save(all.filter { it.id != id })
        if (r.portal.isNotEmpty() && portal != null && r.portal != portal) return false
        _due.tryEmit(r)
        return true
    }

    private fun save(list: List<Reminder>) {
        all = list
        prefs.reminders = list
        _list.value = ReminderRules.forPortal(list, portal)
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
