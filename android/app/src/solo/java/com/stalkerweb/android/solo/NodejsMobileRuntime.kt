package com.stalkerweb.android.solo

import java.io.File

/**
 * Node from nodejs-mobile (libnode.so), started through the native bridge
 * (src/solo/cpp/node-bridge.cpp). Node can start only once per process, so this
 * runs in SoloServerService's own process (":node").
 */
object NodejsMobileRuntime : NodeRuntime {
    init {
        System.loadLibrary("node")
        System.loadLibrary("node-bridge")
    }

    override fun start(entry: File, args: List<String>, env: Map<String, String>): Int =
        startNode(
            (listOf("node", entry.absolutePath) + args).toTypedArray(),
            env.map { (k, v) -> "$k=$v" }.toTypedArray(),
        )

    private external fun startNode(args: Array<String>, env: Array<String>): Int
}
