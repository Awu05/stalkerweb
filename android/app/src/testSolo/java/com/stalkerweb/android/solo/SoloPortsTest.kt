package com.stalkerweb.android.solo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SoloPortsTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `a saved port that's free is kept`() {
        assertEquals(18983, SoloPorts.choose(18983, { true }, { error("nothing to pick") }))
    }

    @Test fun `a taken or impossible port is replaced`() {
        assertEquals(40000, SoloPorts.choose(18983, { it != 18983 }, { 40000 }))
        assertEquals(40000, SoloPorts.choose(0, { true }, { 40000 }))
        assertEquals(40000, SoloPorts.choose(70000, { true }, { 40000 }))
    }

    @Test fun `with none saved one is picked`() {
        assertEquals(40000, SoloPorts.choose(null, { true }, { 40000 }))
    }

    @Test fun `port and key survive a save and a read, and a missing file reads as nothing`() {
        val file = File(tmp.root, "solo.properties")
        assertNull(SoloConfig.read(file))
        SoloConfig.write(file, SoloConfig(18983, "k3y"))
        assertEquals(SoloConfig(18983, "k3y"), SoloConfig.read(file))
        SoloConfig.write(file, SoloConfig(40000, "k3y"))
        assertEquals(40000, SoloConfig.read(file)!!.port)
        assertEquals(false, SoloConfig(1, "k3y").toString().contains("k3y"))
    }

    @Test fun `a file saved with a cast port still reads, without it`() {
        val file = File(tmp.root, "solo.properties")
        file.writeText("port=18983\ncastPort=18984\nkey=k3y\n")
        assertEquals(SoloConfig(18983, "k3y"), SoloConfig.read(file))
        SoloConfig.write(file, SoloConfig.read(file)!!)
        assertEquals(false, file.readText().contains("castPort"))
    }
}
