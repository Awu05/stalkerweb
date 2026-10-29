package com.stalkerweb.android.solo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SoloPortsTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Hands out 40000, 40001, … */
    private fun counter(start: Int = 40000): () -> Int { var next = start; return { next++ } }

    @Test fun `saved ports that are free are kept`() {
        assertEquals(18983 to 18984, SoloPorts.choose(18983 to 18984, { true }, { error("nothing to pick") }))
    }

    @Test fun `a taken port is replaced, the free one kept`() {
        assertEquals(40000 to 18984, SoloPorts.choose(18983 to 18984, { it != 18983 }, counter()))
        assertEquals(18983 to 40000, SoloPorts.choose(18983 to 18984, { it != 18984 }, counter()))
        assertEquals(40000 to 40001, SoloPorts.choose(18983 to 18984, { false }, counter()))
    }

    @Test fun `with none saved both are picked, never the same one`() {
        assertEquals(40000 to 40001, SoloPorts.choose(null, { true }, counter()))
        // A picker that hands out the same port twice: the second is picked again.
        val picks = ArrayDeque(listOf(40000, 40000, 40002))
        val (a, b) = SoloPorts.choose(null, { true }, { picks.removeFirst() })
        assertNotEquals(a, b)
        // And a replacement can't land on the port that's kept.
        val again = ArrayDeque(listOf(18984, 40000))
        assertEquals(40000 to 18984, SoloPorts.choose(18983 to 18984, { it != 18983 }, { again.removeFirst() }))
    }

    @Test fun `ports and key survive a save and a read, and a missing file reads as nothing`() {
        val file = File(tmp.root, "solo.properties")
        assertNull(SoloConfig.read(file))
        SoloConfig.write(file, SoloConfig(18983, 18984, "k3y"))
        assertEquals(SoloConfig(18983, 18984, "k3y"), SoloConfig.read(file))
        SoloConfig.write(file, SoloConfig(40000, 18984, "k3y"))
        assertEquals(40000, SoloConfig.read(file)!!.port)
        assertEquals(false, SoloConfig(1, 2, "k3y").toString().contains("k3y"))
    }
}
