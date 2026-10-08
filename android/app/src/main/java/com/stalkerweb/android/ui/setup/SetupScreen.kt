package com.stalkerweb.android.ui.setup

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.repository.ChannelRepository
import com.stalkerweb.android.ui.utils.rememberIsTV
import android.net.Uri
import kotlinx.coroutines.launch
import retrofit2.HttpException
import java.net.URI

private data class ServerAddress(val host: String, val port: String, val accessKey: String)

// The saved URL is scheme://host[:port][/k/<access key>] — with an ACCESS_KEY
// on the server, every request goes under /k/<key>, which also covers the
// stream and logo links the app builds from this base.
private fun parseUrl(raw: String): ServerAddress {
    // Blank config → empty port (not a forced 3000). A pre-filled port silently
    // breaks reverse-proxied FQDNs like https://iptv.example.com, where the port
    // is implied (443). The Port field's placeholder still hints "3000".
    if (raw.isBlank()) return ServerAddress("http://", "", "")
    return runCatching {
        val uri = URI(raw)
        val scheme = uri.scheme ?: "http"
        val host   = uri.host   ?: ""
        val port   = if (uri.port > 0) uri.port.toString() else ""
        val path   = uri.rawPath ?: ""
        val key    = if (path.startsWith("/k/")) Uri.decode(path.removePrefix("/k/").trimEnd('/')) else ""
        ServerAddress("$scheme://$host", port, key)
    }.getOrElse { ServerAddress(raw, "", "") }
}

private fun connectError(e: Throwable): String = when ((e as? HttpException)?.code()) {
    401  -> "Wrong or missing access key"
    403  -> "That key only allows playback — enter the access key itself, not the Xtream password"
    429  -> "Too many wrong access keys — try again in 15 minutes"
    else -> "Cannot reach server: ${e.message}"
}

@Composable
fun SetupScreen(
    repository: ChannelRepository,
    onConnected: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val initial = remember { parseUrl(repository.getServerUrl() ?: "") }
    var host    by remember { mutableStateOf(initial.host) }
    var port    by remember { mutableStateOf(initial.port) }
    var accessKey by remember { mutableStateOf(initial.accessKey) }
    var testing by remember { mutableStateOf(false) }
    var error   by remember { mutableStateOf<String?>(null) }
    val scope   = rememberCoroutineScope()
    val focus   = LocalFocusManager.current
    val hostFocusRequester = remember { FocusRequester() }
    val isTV    = rememberIsTV()

    // Auto-focus the host field on load — essential on TV where there's no tap to focus
    LaunchedEffect(Unit) {
        try { hostFocusRequester.requestFocus() } catch (_: Exception) {}
    }

    fun tryConnect() {
        var h = host.trim().trimEnd('/')
        val p = port.trim()
        if (h.isBlank()) return
        // Default to http:// when no scheme is given so a bare host still yields a
        // valid base URL (https FQDNs are entered with their scheme).
        if (!h.contains("://")) h = "http://$h"
        // If the address already carries an explicit port, use it as-is and ignore
        // the Port field. Otherwise append the Port field only when one is given; a
        // blank port lets the scheme default apply (80/443) — needed for reverse-
        // proxied FQDNs like https://iptv.example.com with no port.
        val hasExplicitPort = runCatching { URI(h).port > 0 }.getOrDefault(false)
        val serverUrl = when {
            hasExplicitPort -> h
            p.isNotEmpty()  -> "$h:$p"
            else            -> h
        }
        val key = accessKey.trim()
        val fullUrl = if (key.isEmpty()) serverUrl else "$serverUrl/k/${Uri.encode(key)}"
        error   = null
        testing = true
        scope.launch {
            runCatching {
                // Test first; only persist the URL once it actually connects so a
                // failed/abandoned edit never leaves the app on a broken server.
                repository.testServerUrl(fullUrl)
            }.onSuccess {
                testing = false
                repository.setServerUrl(fullUrl)
                onConnected()
            }.onFailure { e ->
                testing = false
                error = connectError(e)
            }
        }
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // Shown only when reachable from inside the app (editing settings), not on
        // first-run setup where there's nowhere to go back to.
        if (onBack != null) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        }
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .padding(32.dp)
                // A phone-width form centered in a TV screen leaves huge empty
                // gutters either side — give it more room to breathe there.
                .widthIn(max = if (isTV) 560.dp else 400.dp),
        ) {
            Icon(
                Icons.Default.Tv,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(48.dp),
            )
            Spacer(Modifier.height(16.dp))
            Text(
                "stalkerweb",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Enter your stalkerweb server address",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
            )
            Spacer(Modifier.height(32.dp))

            OutlinedTextField(
                value = host,
                onValueChange = { host = it; error = null },
                label = { Text("Server address") },
                placeholder = { Text("http://192.168.1.10") },
                singleLine = true,
                isError = error != null,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                modifier = Modifier.fillMaxWidth().focusRequester(hostFocusRequester),
            )

            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter(Char::isDigit); error = null },
                label = { Text("Port") },
                placeholder = { Text("3000") },
                singleLine = true,
                isError = error != null,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(12.dp))

            // Only needed when the server sets ACCESS_KEY.
            OutlinedTextField(
                value = accessKey,
                onValueChange = { accessKey = it; error = null },
                label = { Text("Access key (if set)") },
                singleLine = true,
                isError = error != null,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { tryConnect() }),
                modifier = Modifier.fillMaxWidth(),
            )

            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    error!!,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Spacer(Modifier.height(16.dp))

            Button(
                onClick = ::tryConnect,
                enabled = !testing && host.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                if (testing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("Connecting…")
                } else {
                    Text("Connect")
                }
            }
        }
    }
}
