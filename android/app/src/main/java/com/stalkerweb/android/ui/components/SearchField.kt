package com.stalkerweb.android.ui.components

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * The search box with its ✕. On a TV the remote passes over it without the
 * keyboard popping up: it opens only on OK (the centre button), and closes
 * again when focus moves on.
 */
@Composable
fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    onFocusChange: (Boolean) -> Unit = {},
) {
    val isTv = rememberIsTV()
    val keyboard = LocalSoftwareKeyboardController.current
    // On a TV the field is read-only (no keyboard) until OK is pressed on it.
    var typing by remember { mutableStateOf(!isTv) }
    LaunchedEffect(typing) { if (isTv && typing) keyboard?.show() }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder) },
        leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
        trailingIcon = if (value.isNotEmpty()) ({ IconButton(onClick = { onValueChange("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
        singleLine = true,
        readOnly = !typing,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
        shape = RoundedCornerShape(10.dp),
        modifier = modifier
            .onFocusChanged {
                if (isTv && !it.isFocused) typing = false
                onFocusChange(it.isFocused)
            }
            .onPreviewKeyEvent { e ->
                val ok = e.key == Key.DirectionCenter || e.key == Key.Enter || e.key == Key.NumPadEnter
                if (!isTv || !ok) return@onPreviewKeyEvent false
                // Both halves of the press are ours, so the field never sees a stray OK.
                if (e.type == KeyEventType.KeyDown) { if (typing) keyboard?.show() else typing = true }
                true
            },
    )
}
