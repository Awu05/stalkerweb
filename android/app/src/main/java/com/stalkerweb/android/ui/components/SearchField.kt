package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
 * Keyboard options for a text box: on a TV the remote passes over it without
 * the keyboard popping up — OK (the centre button) opens it, and a remote's
 * number keys still type. Phones keep the keyboard on focus.
 */
@Composable
fun tvKeyboardOptions(base: KeyboardOptions = KeyboardOptions.Default): KeyboardOptions =
    base.copy(showKeyboardOnFocus = !rememberIsTV())

/**
 * On a TV, typing in a text box waits for OK: the remote passes over the box
 * while it's read-only (a read-only box never brings the keyboard up — asking
 * the keyboard not to show on focus wasn't enough on the Shield), OK on it
 * makes it editable and opens the keyboard, and leaving it ends the typing.
 * Put [modifier] on the box and pass [readOnly] to it. On a phone it does nothing.
 */
class TvTyping(val readOnly: Boolean, val modifier: Modifier)

@Composable
fun rememberTvTyping(): TvTyping {
    val isTV = rememberIsTV()
    var typing by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(typing) { if (typing) keyboard?.show() }
    if (!isTV) return TvTyping(readOnly = false, modifier = Modifier)
    return TvTyping(
        readOnly = !typing,
        modifier = Modifier
            .onFocusChanged { if (!it.isFocused) typing = false }
            .onPreviewKeyEvent { e ->
                val ok = e.key == Key.DirectionCenter || e.key == Key.Enter || e.key == Key.NumPadEnter
                if (!typing && ok && e.type == KeyEventType.KeyDown) { typing = true; true } else false
            },
    )
}

/** The search box with its ✕; on a TV the keyboard waits for OK (rememberTvTyping). */
@Composable
fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    onFocusChange: (Boolean) -> Unit = {},
) {
    val keyboard = LocalSoftwareKeyboardController.current
    val tv = rememberTvTyping()
    OutlinedTextField(
        value = value,
        readOnly = tv.readOnly,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder) },
        leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
        trailingIcon = if (value.isNotEmpty()) ({ TipIconButton(label = "Clear", onClick = { onValueChange("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
        singleLine = true,
        keyboardOptions = tvKeyboardOptions(KeyboardOptions(imeAction = ImeAction.Search)),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.then(tv.modifier).onFocusChanged { onFocusChange(it.isFocused) },
    )
}
