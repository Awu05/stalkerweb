package com.stalkerweb.android.data.repo

/**
 * Answers can arrive out of order — a progress save sent before a My List
 * change can answer after it, with the list as it was. Each request is
 * numbered when sent ([next]); its answer is used ([accept]) only if nothing
 * newer has been answered, nor changed here, since. As in the web's vodProgress.js.
 */
class RequestOrder {
    private var sent = 0
    private var answered = 0
    private var changedAt = 0

    @Synchronized fun next(local: Boolean): Int {
        val n = ++sent
        if (local) changedAt = n
        return n
    }

    @Synchronized fun accept(n: Int): Boolean {
        if (n <= answered || n < changedAt) return false
        answered = n
        return true
    }
}
