package com.stalkerweb.android.ui.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/**
 * Solo, until the server inside the app answers (SoloServer.awaitReady):
 * "Starting…" — or, when it hasn't within the wait, a way to try again.
 */
@Composable
fun StartingScreen(failed: Boolean, onRetry: () -> Unit) {
    val focus = remember { FocusRequester() }
    Column(
        // Covers the screens below and holds the focus (a TV remote), so nothing there is used meanwhile.
        Modifier.fillMaxSize().background(SwColors.Bg).focusRequester(focus).focusable().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (failed) {
            Text("The server inside the app didn't start", style = MaterialTheme.typography.titleMedium, color = SwColors.Text, textAlign = TextAlign.Center)
            Text("Try again; if it still won't, close the app and open it again.", style = MaterialTheme.typography.bodyMedium, color = SwColors.Muted, textAlign = TextAlign.Center)
            Button(onClick = onRetry) { Text("Try again") }
        } else {
            CircularProgressIndicator(Modifier.size(32.dp), strokeWidth = 3.dp)
            Text("Starting…", style = MaterialTheme.typography.titleMedium, color = SwColors.Text)
        }
    }
    LaunchedEffect(failed) { if (!failed) runCatching { focus.requestFocus() } }
}
