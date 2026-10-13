package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent

/** The programme guide (backend /api/epg, 24 h), by channel uniqueId, each in time order; cached 10 minutes. */
class GuideRepository(private val apis: ApiProvider) {
    private var cache: Pair<Long, Map<String, List<EpgEvent>>>? = null

    suspend fun guide(force: Boolean = false): Map<String, List<EpgEvent>> {
        val now = System.currentTimeMillis()
        cache?.let { (at, epg) -> if (!force && now - at < 10 * 60_000L) return epg }
        val epg = apis.get().getEpg(24).epg.mapValues { (_, events) -> cleanEvents(events) }
        cache = now to epg
        return epg
    }
}
