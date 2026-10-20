package com.stalkerweb.android.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation

/** The eye at the end of a password field: shows or hides what's typed. */
@Composable
fun PasswordEye(shown: Boolean, onToggle: () -> Unit) {
    IconButton(onClick = onToggle) {
        Icon(
            if (shown) Icons.Default.VisibilityOff else Icons.Default.Visibility,
            contentDescription = if (shown) "Hide password" else "Show password",
        )
    }
}

/** The field's text as typed, or dots. */
fun passwordTransformation(shown: Boolean): VisualTransformation =
    if (shown) VisualTransformation.None else PasswordVisualTransformation()
