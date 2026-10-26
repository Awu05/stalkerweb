package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
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

/** The search box with its ✕; on a TV the keyboard waits for OK (tvKeyboardOptions). */
@Composable
fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    onFocusChange: (Boolean) -> Unit = {},
) {
    val keyboard = LocalSoftwareKeyboardController.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder) },
        leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
        trailingIcon = if (value.isNotEmpty()) ({ IconButton(onClick = { onValueChange("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
        singleLine = true,
        keyboardOptions = tvKeyboardOptions(KeyboardOptions(imeAction = ImeAction.Search)),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.onFocusChanged { onFocusChange(it.isFocused) },
    )
}
