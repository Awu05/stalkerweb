package com.stalkerweb.android.solo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class ServerInstallerTest {
    @get:Rule val tmp = TemporaryFolder()

    /** A server.zip as pack-solo-server.sh makes it: everything under backend/. */
    private fun zipOf(vararg files: Pair<String, String>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            files.forEach { (name, text) -> zip.putNextEntry(ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry() }
        }
        return out.toByteArray()
    }

    /** Assets holding [zip] as server.zip, counting how often it's opened. */
    private class FakeAssets(val zip: ByteArray) : AssetSource {
        var opened = 0
        override fun open(name: String) =
            if (name == "server.zip") { opened++; ByteArrayInputStream(zip) } else throw FileNotFoundException(name)
    }

    private val serverZip = zipOf("backend/server.js" to "// server", "backend/lib/a.js" to "// a")

    @Test fun `installs the server once per version, and clears older ones`() {
        val root = tmp.newFolder("server")
        val assets = FakeAssets(serverZip)

        val entry = ServerInstaller.ensureInstalled(assets, "v1", root)
        assertEquals(File(root, "v1/backend/server.js"), entry)
        assertEquals("// server", entry.readText())
        assertEquals("// a", File(root, "v1/backend/lib/a.js").readText())

        // Already there: not extracted again.
        entry.setLastModified(1_000_000_000_000)
        assertEquals(entry, ServerInstaller.ensureInstalled(assets, "v1", root))
        assertEquals(1, assets.opened)
        assertEquals(1_000_000_000_000, entry.lastModified())

        // A new version replaces the old one.
        val next = ServerInstaller.ensureInstalled(assets, "v2", root)
        assertEquals(File(root, "v2/backend/server.js"), next)
        assertTrue(next.isFile)
        assertFalse(File(root, "v1").exists())
        assertEquals(listOf("v2"), root.list()!!.toList())
    }

    @Test fun `an install cut short is redone`() {
        val root = tmp.newFolder("server")
        // A folder for this version but no done-marker: extraction stopped part way.
        File(root, "v1/backend").mkdirs()
        File(root, "v1/backend/half.js").writeText("// half")
        val assets = FakeAssets(serverZip)

        val entry = ServerInstaller.ensureInstalled(assets, "v1", root)
        assertEquals(1, assets.opened)
        assertEquals("// server", entry.readText())
        assertFalse(File(root, "v1/backend/half.js").exists())
    }

    @Test fun `a zip entry can't write outside the install folder`() {
        val root = tmp.newFolder("server")
        val evil = FakeAssets(zipOf("backend/server.js" to "//", "../../escaped.js" to "//"))
        val failed = runCatching { ServerInstaller.ensureInstalled(evil, "v1", root) }.isFailure
        assertTrue(failed)
        assertFalse(File(tmp.root, "escaped.js").exists())
        assertFalse(File(root.parentFile, "escaped.js").exists())
    }
}
