package com.stalkerweb.android.solo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

class SoloEnvTest {
    @Test fun `the environment puts the server on this device only, with its key and folders`() {
        val env = SoloEnv.build(18983, "k3y", File("/d"), File("/d/dl"), "0.5.0")
        assertEquals("127.0.0.1", env["HOST"]); assertEquals("1", env["SOLO"]); assertEquals("18983", env["PORT"])
        assertEquals("k3y", env["ACCESS_KEY"]); assertEquals(File("/d").path, env["DATA_DIR"])
        assertEquals(File("/d/dl").path, env["DOWNLOAD_DIR"]); assertEquals("0.5.0", env["APP_VERSION"])
        assertEquals("production", env["NODE_ENV"])
    }

    @Test fun `no cast port, the server picks one each time it starts casting`() {
        assertFalse(SoloEnv.build(18983, "k3y", File("/d"), File("/d/dl"), "0.5.0").containsKey("CAST_PORT"))
    }
}
