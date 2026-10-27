package com.stalkerweb.android.ui.portal

import com.stalkerweb.android.ui.components.TipIconButton

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.ui.utils.rememberIsTV

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PortalScreen(
    viewModel: PortalViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV  = rememberIsTV()
    // Compose gives no element initial D-pad focus on its own — without this,
    // landing here via a TV remote (no touchscreen) leaves the screen looking
    // unresponsive since nothing is focused yet.
    val firstFocusRequester = remember { FocusRequester() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Portal connection") },
                navigationIcon = {
                    TipIconButton(label = "Back", onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { innerPadding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when {
                state.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                else -> {
                    LaunchedEffect(Unit) {
                        try { firstFocusRequester.requestFocus() } catch (_: Exception) {}
                    }
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(24.dp)
                            .widthIn(max = if (isTV) 640.dp else 480.dp)
                            .align(Alignment.TopCenter),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        // Status card
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = if (state.connected)
                                    MaterialTheme.colorScheme.primaryContainer
                                else
                                    MaterialTheme.colorScheme.surfaceVariant,
                            ),
                        ) {
                            Row(
                                Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Icon(
                                    imageVector = if (state.connected) Icons.Default.CheckCircle
                                                  else Icons.Default.Warning,
                                    contentDescription = null,
                                    tint = if (state.connected) MaterialTheme.colorScheme.primary
                                           else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Column {
                                    Text(
                                        if (state.connected) "Connected" else "Disconnected",
                                        style = MaterialTheme.typography.titleSmall,
                                        color = if (state.connected) MaterialTheme.colorScheme.primary
                                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    if (state.connected && state.portalUrl.isNotBlank()) {
                                        Text(
                                            state.portalUrl,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }

                        // Saved profiles — one-tap connect, same list the web
                        // UI shows. Portal setup itself is a web-UI job, so
                        // there's deliberately no manual portal/MAC entry here.
                        if (!state.connected) {
                            if (state.profiles.isNotEmpty()) {
                                Text(
                                    "Available portals",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                state.profiles.forEachIndexed { index, profile ->
                                    ProfileRow(
                                        profile        = profile,
                                        connecting     = state.connectingProfileId == profile.id,
                                        enabled        = !state.busy,
                                        onClick        = { viewModel.connectProfile(profile) },
                                        focusRequester = if (index == 0) firstFocusRequester else null,
                                    )
                                }
                            } else {
                                Text(
                                    "No saved portals. Add one from the stalkerweb web UI.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }

                        // Error message
                        if (state.error != null) {
                            Text(
                                state.error!!,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }

                        // Action buttons. Both act on config the backend already
                        // holds — nothing here composes a connection by hand.
                        if (state.connected) {
                            OutlinedButton(
                                onClick = viewModel::disconnect,
                                enabled = !state.busy,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(48.dp)
                                    .focusRequester(firstFocusRequester),
                                colors = ButtonDefaults.outlinedButtonColors(
                                    contentColor = MaterialTheme.colorScheme.error,
                                ),
                            ) {
                                if (state.busy) {
                                    CircularProgressIndicator(
                                        Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                }
                                Text("Disconnect")
                            }
                        } else if (state.hasSavedConfig) {
                            OutlinedButton(
                                onClick = viewModel::reconnect,
                                enabled = !state.busy,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(48.dp)
                                    .then(
                                        // Only claim initial focus when no profile
                                        // row above already took it.
                                        if (state.profiles.isEmpty()) Modifier.focusRequester(firstFocusRequester)
                                        else Modifier
                                    ),
                            ) {
                                if (state.busy) {
                                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                    Spacer(Modifier.width(8.dp))
                                }
                                Text("Reconnect with saved config")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProfileRow(
    profile: Profile,
    connecting: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    focusRequester: FocusRequester? = null,
) {
    OutlinedButton(
        onClick  = onClick,
        enabled  = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
    ) {
        if (connecting) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                profile.name.ifBlank { profile.portal },
                style = MaterialTheme.typography.bodyMedium,
            )
            if (profile.name.isNotBlank()) {
                Text(
                    profile.portal,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
