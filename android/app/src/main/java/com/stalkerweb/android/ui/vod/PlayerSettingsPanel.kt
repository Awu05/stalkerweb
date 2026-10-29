package com.stalkerweb.android.ui.vod

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.repo.AudioTrack
import com.stalkerweb.android.data.repo.SKIP_MODES
import com.stalkerweb.android.data.repo.audioTrackLabels
import com.stalkerweb.android.ui.components.AudioLanguagePicker
import com.stalkerweb.android.ui.components.TipIconButton
import com.stalkerweb.android.ui.theme.SwColors

/**
 * The player's settings gear (the web's PlayerSettingsMenu): this title's audio
 * track, the viewer's preferred audio language, and intro skipping. A side
 * panel on wide screens and TV, a bottom one on phones — as the subtitles one.
 */
@Composable
internal fun PlayerSettingsPanel(
    audio: List<AudioTrack>, settings: PlayerSettings?, wide: Boolean,
    onPickAudio: (AudioTrack) -> Unit, onAudioLanguage: (String) -> Unit, onSkipMode: (String) -> Unit,
    onClose: () -> Unit, modifier: Modifier,
) {
    val firstFocus = remember { FocusRequester() }
    val labels = audioTrackLabels(audio)
    Surface(color = SwColors.Surface.copy(alpha = 0.96f), shape = RoundedCornerShape(if (wide) 0.dp else 12.dp), modifier = modifier) {
        LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Player settings", style = MaterialTheme.typography.titleSmall, color = SwColors.Text, modifier = Modifier.weight(1f))
                    TipIconButton(label = "Close player settings", onClick = onClose) { Icon(Icons.Default.Close, "Close player settings") }
                }
            }
            item { SubtitleHeading("Audio") }
            if (audio.size < 2) item { SubtitleNote("This video has one audio track.") }
            else itemsIndexed(audio, key = { _, t -> "a${t.group}-${t.track}" }) { i, t ->
                SubtitleRow(labels[i], null, t.selected, if (i == 0) Modifier.focusRequester(firstFocus) else Modifier) { onPickAudio(t) }
            }
            item { SubtitleHeading("Preferred audio language") }
            item {
                AudioLanguagePicker(settings?.audioLanguage, enabled = settings != null, onPick = onAudioLanguage,
                    modifier = Modifier.padding(start = 8.dp, top = 2.dp).then(if (audio.size < 2) Modifier.focusRequester(firstFocus) else Modifier))
            }
            item { SubtitleNote("Each movie or episode starts in it where it has a track in it.") }
            item { SubtitleHeading("Intro skipping") }
            SKIP_MODES.forEach { (id, label) ->
                item(key = "s$id") { SubtitleRow(label, null, settings?.skipMode == id) { if (settings != null) onSkipMode(id) } }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { firstFocus.requestFocus() } }
}
