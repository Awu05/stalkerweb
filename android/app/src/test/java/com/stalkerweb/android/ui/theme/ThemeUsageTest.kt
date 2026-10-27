package com.stalkerweb.android.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The app keeps to the theme (theme/tokens.json → Tokens.kt): no colours of
 * its own outside ui/theme/, and a fill always with its On… colour. The
 * website has the same check (frontend/src/theme.test.js); both run on every CI.
 */
class ThemeUsageTest {
    // Unit tests run in the module folder (android/app).
    private val sources = File("src/main/java").walkTopDown()
        .filter { it.isFile && it.extension == "kt" && !it.invariantSeparatorsPath.contains("/ui/theme/") }
        .toList()

    private fun problems(): List<String> = sources.flatMap { file ->
        file.readLines().mapIndexedNotNull { i, raw ->
            val line = raw.substringBefore("//")
            val at = "${file.invariantSeparatorsPath.substringAfter("src/main/java/")}:${i + 1}"
            when {
                Regex("""Color\(0x""").containsMatchIn(line) -> "$at: a colour of its own — use SwColors"
                Regex(""""#[0-9a-fA-F]{6}"""").containsMatchIn(line) -> "$at: a hex colour of its own — put it in theme/tokens.json"
                // The bright red is for text and marks; a red fill holding content is LiveFill (OnLive on it).
                Regex("""(?:Surface\(\s*color|containerColor)\s*=\s*(?:SwColors\.Live\b|MaterialTheme\.colorScheme\.error\b)""").containsMatchIn(line) ->
                    "$at: a fill of the bright red — use SwColors.LiveFill, with SwColors.OnLive on it"
                // A theme fill with a text or icon colour picked by hand, not its On… one.
                Regex("""containerColor\s*=\s*SwColors\.(Primary|LiveFill|Success|Warning)\b""").find(line)?.let { m ->
                    val on = "SwColors.On" + m.groupValues[1].removeSuffix("Fill")
                    val content = Regex("""contentColor\s*=\s*([\w.]+)""").find(line)?.groupValues?.get(1)
                    content != null && content != on
                } == true -> "$at: a fill whose content colour isn't its On… colour"
                else -> null
            }
        }
    }

    @Test fun `finds the app's sources`() {
        assertTrue("no Kotlin sources found from ${File(".").absolutePath}", sources.size > 20)
    }

    @Test fun `uses only the theme's colours, each fill with its On colour`() {
        assertEquals(emptyList<String>(), problems())
    }

    @Test fun `gives every icon button a tooltip (TipIconButton, not Material's IconButton)`() {
        val raw = sources.filter { !it.name.equals("TipIconButton.kt") }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                // Bare, or spelt out (androidx.compose.material3.IconButton).
                if (Regex("""(?<![\w])(?:[\w.]*\.)?IconButton\(""").findAll(line.substringBefore("//")).any { !it.value.startsWith("Tip") && !it.value.contains("TipIconButton") }) "${file.name}:${i + 1}" else null
            }
        }
        assertEquals(emptyList<String>(), raw)
    }

    @Test fun `gives every viewer colour readable initials`() {
        for (v in VIEWER_COLORS) assertTrue("${v.hex} has initials", v.on == SwColors.PrimaryLight || v.on == SwColors.Bg)
    }
}
