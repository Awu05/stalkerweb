package com.stalkerweb.android.ui.components

import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.VisualTransformation
import com.stalkerweb.android.ui.utils.isOkKey
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * On a TV, typing in a text box waits for OK: the remote passes over the box
 * while it's read-only (a read-only box never brings the keyboard up — asking
 * the keyboard not to show on focus wasn't enough on the Shield), OK on it
 * makes it editable and opens the keyboard, and leaving it ends the typing.
 * The remote's number keys type without the keyboard ([onType]: a digit to
 * add). Put [modifier] on the box and pass [readOnly] to it — or use
 * TvTextField, which does. On a phone it does nothing.
 */
class TvTyping(val readOnly: Boolean, val modifier: Modifier)

@Composable
fun rememberTvTyping(onType: ((String) -> Unit)? = null): TvTyping {
    val isTV = rememberIsTV()
    var typing by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val type by rememberUpdatedState(onType)
    // After the box has become editable and its input has started (two frames on), or show() finds none.
    LaunchedEffect(typing) {
        if (typing) { withFrameNanos { }; withFrameNanos { }; keyboard?.show() }
    }
    if (!isTV) return TvTyping(readOnly = false, modifier = Modifier)
    return TvTyping(
        readOnly = !typing,
        modifier = Modifier
            .onFocusChanged { if (!it.isFocused) typing = false }
            .onPreviewKeyEvent { e ->
                if (typing || e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val digit = e.utf16CodePoint.toChar().takeIf { it in '0'..'9' }
                when {
                    isOkKey(e.key) -> { typing = true; true }
                    digit != null && type != null -> { type?.invoke(digit.toString()); true }
                    else -> false
                }
            },
    )
}

/**
 * The app's text box: Material's outlined one, and on a TV it opens the
 * keyboard only on OK (rememberTvTyping) — every text box is one of these
 * (ThemeUsageTest checks). The remote's number keys add to its value.
 */
@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    label: (@Composable () -> Unit)? = null,
    placeholder: (@Composable () -> Unit)? = null,
    leadingIcon: (@Composable () -> Unit)? = null,
    trailingIcon: (@Composable () -> Unit)? = null,
    supportingText: (@Composable () -> Unit)? = null,
    isError: Boolean = false,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    singleLine: Boolean = false,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    shape: Shape = OutlinedTextFieldDefaults.shape,
) {
    val current by rememberUpdatedState(value)
    val tv = rememberTvTyping(onType = if (readOnly || !enabled) null else { digit -> onValueChange(current + digit) })
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.then(tv.modifier),
        enabled = enabled,
        readOnly = readOnly || tv.readOnly,
        label = label,
        placeholder = placeholder,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        supportingText = supportingText,
        isError = isError,
        visualTransformation = visualTransformation,
        keyboardOptions = tvKeyboardOptions(keyboardOptions),
        keyboardActions = keyboardActions,
        singleLine = singleLine,
        maxLines = maxLines,
        shape = shape,
    )
}
