package com.stalkerweb.android.ui.downloads

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.repo.formatBytes
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors

/** Downloads to the server (the web's DownloadsPage): live progress, Cancel / Delete. */
@Composable
fun DownloadsScreen(viewModel: DownloadsViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { viewModel.follow() } }
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    Column(Modifier.fillMaxSize()) {
        Text("Downloads", style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.padding(16.dp))
        when {
            state.loading -> CircularProgressIndicator(Modifier.padding(32.dp))
            state.jobs.isEmpty() -> EmptyState(Icons.Default.Download, "No downloads", state.error ?: "Download a movie or episode from VOD to save it on the server.")
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.jobs, key = { it.id }) { job -> JobRow(job) { viewModel.remove(job) } }
            }
        }
    }
}

@Composable
private fun JobRow(job: DownloadJob, onRemove: () -> Unit) {
    val active = job.status == "queued" || job.status == "downloading"
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    if (job.seriesTitle.isNotBlank()) Text(job.seriesTitle, style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                    Text(job.title, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        when (job.status) {
                            "queued" -> "Queued"
                            "downloading" -> "Downloading · ${formatBytes(job.bytesDownloaded)}${if (job.totalBytes > 0) " of ${formatBytes(job.totalBytes)}" else ""}"
                            "done" -> "Done · ${formatBytes(job.totalBytes.coerceAtLeast(job.bytesDownloaded))}"
                            "canceled" -> "Canceled"
                            else -> "Failed${job.error?.let { " — $it" } ?: ""}"
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = if (job.status == "error") SwColors.Live else SwColors.Muted,
                    )
                }
                OutlinedButton(onClick = onRemove, modifier = Modifier.tvFocus(RoundedCornerShape(50))) { Text(if (active) "Cancel" else "Delete") }
            }
            if (job.status == "downloading") {
                if (job.totalBytes > 0) {
                    LinearProgressIndicator(progress = { (job.bytesDownloaded.toFloat() / job.totalBytes).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().height(4.dp), color = SwColors.Primary, trackColor = SwColors.Surface3)
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(4.dp), color = SwColors.Primary, trackColor = SwColors.Surface3)
                }
            }
        }
    }
}
