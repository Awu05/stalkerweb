package com.stalkerweb.android.ui.update

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.update.ReleaseInfo
import com.stalkerweb.android.data.update.UpdateCheck
import com.stalkerweb.android.data.update.UpdateManager
import com.stalkerweb.android.data.update.checkMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

sealed class UpdateState {
    object Idle : UpdateState()
    data class Available(val release: ReleaseInfo) : UpdateState()
    data class Downloading(val progress: Float) : UpdateState()
    data class ReadyToInstall(val file: File) : UpdateState()
}

class UpdateViewModel(private val manager: UpdateManager) : ViewModel() {

    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    // One-shot event the Activity observes to trigger the install intent with
    // an Activity context + ActivityResultLauncher.
    private val _installEvent = MutableSharedFlow<File>(extraBufferCapacity = 1)
    val installEvent: SharedFlow<File> = _installEvent.asSharedFlow()

    fun check() {
        // Restore ReadyToInstall if the APK survived a process death / Settings round-trip
        val cached = manager.cachedApk()
        if (cached != null) {
            _state.value = UpdateState.ReadyToInstall(cached)
            return
        }
        viewModelScope.launch {
            val found = manager.latest() as? UpdateCheck.Found ?: return@launch
            _state.value = UpdateState.Available(found.release)
        }
    }

    // The line under Settings' "Check for updates" button (null before a check).
    private val _checkStatus = MutableStateFlow<String?>(null)
    val checkStatus: StateFlow<String?> = _checkStatus.asStateFlow()
    private val _checking = MutableStateFlow(false)
    val checking: StateFlow<Boolean> = _checking.asStateFlow()

    /** A check by hand, from Settings: says what it found, and offers a newer APK. */
    fun checkNow() {
        if (_checking.value) return
        val cached = manager.cachedApk()
        if (cached != null) {
            _checkStatus.value = "An update is downloaded and ready to install."
            _state.value = UpdateState.ReadyToInstall(cached)
            return
        }
        _checking.value = true
        _checkStatus.value = "Checking…"
        viewModelScope.launch {
            val result = manager.latest()
            _checking.value = false
            _checkStatus.value = checkMessage(result, BuildConfig.VERSION_NAME)
            if (result is UpdateCheck.Found && _state.value !is UpdateState.Downloading) {
                _state.value = UpdateState.Available(result.release)
            }
        }
    }

    fun download(release: ReleaseInfo) {
        _state.value = UpdateState.Downloading(0f)
        viewModelScope.launch {
            runCatching {
                val file = manager.downloadApk(release) { progress ->
                    _state.value = UpdateState.Downloading(progress)
                }
                _state.value = UpdateState.ReadyToInstall(file)
            }.onFailure {
                _state.value = UpdateState.Available(release)
            }
        }
    }

    /** Called from the Activity (which holds the ActivityResultLauncher). */
    fun install(file: File) {
        _installEvent.tryEmit(file)
    }

    fun dismiss() { _state.value = UpdateState.Idle }
}
