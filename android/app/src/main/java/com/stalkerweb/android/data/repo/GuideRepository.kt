package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent

/**
 * The programme guide (backend /api/epg, 24 h), by channel uniqueId, each in
 * time order; cached 10 minutes, and dropped when [generation] moves on (a
 * portal or viewer change: ViewerRepository.changes).
 */
class GuideRepository(private val apis: ApiProvider) {
    private data class Cached(val at: Long, val generation: Int, val epg: Map<String, List<EpgEvent>>)
    private var cache: Cached? = null

    suspend fun guide(force: Boolean = false, generation: Int = 0): Map<String, List<EpgEvent>> {
        val now = System.currentTimeMillis()
        cache?.let { if (!force && it.generation == generation && now - it.at < 10 * 60_000L) return it.epg }
        val epg = guideEvents(apis.get().getEpg(24).epg)
        cache = Cached(now, generation, epg)
        return epg
    }
}
