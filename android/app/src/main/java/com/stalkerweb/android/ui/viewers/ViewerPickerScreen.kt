package com.stalkerweb.android.ui.viewers

import com.stalkerweb.android.ui.components.tvKeyboardOptions
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.ViewerAvatar
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import kotlinx.coroutines.launch

/**
 * "Who's watching?" (the web's ViewerPicker). [required]: startup, a deleted
 * viewer or a new server — there's no close, and Back leaves the app rather
 * than skipping the choice.
 */
@Composable
fun ViewerPickerScreen(
    viewers: ViewerRepository,
    required: Boolean,
    onChosen: () -> Unit,
    onClose: () -> Unit,
    onExitApp: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<ViewerSummary>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var nameError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val firstFocus = remember { FocusRequester() }

    fun load() {
        loadError = null
        scope.launch {
            runCatching { viewers.list() }
                .onSuccess { list = it }
                .onFailure { loadError = it.toApiError().message }
        }
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(list) { if (!list.isNullOrEmpty()) runCatching { firstFocus.requestFocus() } }
    BackHandler { if (required) onExitApp() else onClose() }

    fun pick(id: String) {
        if (busy) return
        busy = true
        scope.launch { runCatching { viewers.choose(id) }; busy = false; onChosen() }
    }

    fun add() {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || busy) return
        busy = true
        nameError = null
        scope.launch {
            runCatching { viewers.create(trimmed) }
                .onSuccess { busy = false; onChosen() }
                .onFailure { busy = false; nameError = it.toApiError().message }
        }
    }

    Box(Modifier.fillMaxSize().background(SwColors.Bg)) {
        if (!required) {
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)) {
                Icon(Icons.Default.Close, "Close", tint = SwColors.Muted)
            }
        }
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 720.dp).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Text("Who's watching?", style = MaterialTheme.typography.headlineMedium, color = SwColors.Text)
            when {
                loadError != null -> EmptyState(Icons.Default.ErrorOutline, "Couldn't load viewers", loadError) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = ::load) { Text("Retry") }
                        // An older server has no viewers: go on as its default one.
                        if (required) Button(onClick = onChosen) { Text("Continue") }
                    }
                }
                list == null -> CircularProgressIndicator(color = SwColors.Primary)
                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(132.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    items(list.orEmpty(), key = { it.id }) { v ->
                        val first = v.id == list?.firstOrNull()?.id
                        Column(
                            Modifier
                                .then(if (first) Modifier.focusRequester(firstFocus) else Modifier)
                                .tvFocus(RoundedCornerShape(12.dp))
                                .clickable { pick(v.id) }
                                .padding(12.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            ViewerAvatar(v.name, v.color, 88.dp)
                            Text(v.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                        }
                    }
                    item(key = "add") {
                        Column(
                            Modifier.tvFocus(RoundedCornerShape(12.dp)).clickable { adding = true }.padding(12.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Box(Modifier.size(88.dp).border(2.dp, SwColors.Border, CircleShape), contentAlignment = Alignment.Center) {
                                Icon(Icons.Default.Add, null, Modifier.size(32.dp), tint = SwColors.Muted)
                            }
                            Text("Add viewer", color = SwColors.Muted)
                        }
                    }
                }
            }
            if (adding) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it; nameError = null },
                        label = { Text("Name") },
                        singleLine = true,
                        keyboardOptions = tvKeyboardOptions(),
                        isError = nameError != null,
                        supportingText = nameError?.let { { Text(it) } },
                    )
                    Button(onClick = ::add, enabled = name.isNotBlank() && !busy) { Text("Add") }
                }
            }
        }
    }
}
