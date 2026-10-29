package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.repo.SKIP_MODES
import com.stalkerweb.android.data.repo.audioLanguageName
import com.stalkerweb.android.data.repo.audioLanguageOptions
import com.stalkerweb.android.ui.theme.SwColors

// The viewer's player settings, as Settings shows them (the VOD player's gear
// has the same in its panel): intro skipping and the preferred audio language.

/** Off / Show a Skip button / Skip automatically, as pills. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SkipModePills(selected: String?, enabled: Boolean, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SKIP_MODES.forEach { (id, label) -> Pill(label, selected == id, { if (enabled) onPick(id) }) }
    }
}

/** The preferred audio language: a button naming it, opening the list ("Stream default" first). */
@Composable
fun AudioLanguagePicker(selected: String?, enabled: Boolean, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.tvFocus(androidx.compose.foundation.shape.RoundedCornerShape(50))) {
            Text(audioLanguageName(selected.orEmpty()), color = SwColors.Text)
            Icon(Icons.Default.ArrowDropDown, null, tint = SwColors.Muted)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.heightIn(max = 420.dp)) {
            audioLanguageOptions().forEach { (code, name) ->
                DropdownMenuItem(
                    text = { Text(name) },
                    leadingIcon = { if (code == selected.orEmpty()) Icon(Icons.Default.Check, null) },
                    onClick = { open = false; onPick(code) },
                )
            }
        }
    }
}
