package com.stalkerweb.android.ui.player

import com.stalkerweb.android.ui.components.tvKeyboardOptions
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.api.Channel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StreamOverrideSheet(
    channel: Channel,
    currentOverride: String?,
    defaultUrl: String,
    onSave: (url: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember { mutableStateOf(currentOverride ?: "") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Stream URL — ${channel.name}", style = MaterialTheme.typography.titleSmall)

            Text(
                "Default: $defaultUrl",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
            )

            OutlinedTextField(
                value         = text,
                onValueChange = { text = it },
                label         = { Text("Override URL (leave blank to use default)") },
                placeholder   = { Text("https://…") },
                singleLine    = true,
                keyboardOptions = tvKeyboardOptions(KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction    = ImeAction.Done,
                )),
                keyboardActions = KeyboardActions(onDone = { onSave(text.ifBlank { null }) }),
                modifier = Modifier.fillMaxWidth(),
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (currentOverride != null) {
                    OutlinedButton(
                        onClick  = { onSave(null) },
                        modifier = Modifier.weight(1f),
                    ) { Text("Clear override") }
                }
                Button(
                    onClick  = { onSave(text.ifBlank { null }) },
                    modifier = Modifier.weight(1f),
                ) { Text("Save") }
            }
        }
    }
}
