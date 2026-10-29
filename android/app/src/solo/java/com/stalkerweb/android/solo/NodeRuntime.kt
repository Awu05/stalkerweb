package com.stalkerweb.android.solo

import java.io.File

/**
 * Something that runs a Node.js script in this process. Solo uses nodejs-mobile
 * ([NodejsMobileRuntime]); this is the one place another runtime would plug in.
 */
interface NodeRuntime {
    /** Runs [entry] with [args], [env] set; blocks until Node exits and returns its exit code. */
    fun start(entry: File, args: List<String>, env: Map<String, String>): Int
}
