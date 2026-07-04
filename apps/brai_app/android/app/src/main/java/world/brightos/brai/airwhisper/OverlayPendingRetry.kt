package world.brightos.brai.airwhisper

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import world.brightos.brai.capabilities.BraiAccessibilityService

internal class OverlayPendingRetry(
    private val service: BraiAccessibilityService,
    private val handler: Handler
) {
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var retryRunnable: Runnable? = null

    fun start() {
        registerNetworkRetry()
        RecordingService.retryPending(service)
    }

    fun stop() {
        unregisterNetworkRetry()
        cancel()
    }

    fun schedule() {
        if (retryRunnable != null || !RecordingService.hasPendingRecordings(service)) return
        retryRunnable = Runnable {
            retryRunnable = null
            RecordingService.retryPending(service)
        }.also { handler.postDelayed(it, PENDING_RETRY_DELAY_MS) }
    }

    fun cancel() {
        val retry = retryRunnable ?: return
        handler.removeCallbacks(retry)
        retryRunnable = null
    }

    private fun registerNetworkRetry() {
        if (networkCallback != null) return
        val connectivity = service.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                RecordingService.retryPending(service)
            }
        }
        runCatching { connectivity.registerDefaultNetworkCallback(callback) }
            .onSuccess { networkCallback = callback }
    }

    private fun unregisterNetworkRetry() {
        val callback = networkCallback ?: return
        val connectivity = service.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        runCatching { connectivity.unregisterNetworkCallback(callback) }
        networkCallback = null
    }

    companion object {
        private const val PENDING_RETRY_DELAY_MS = 60_000L
    }
}
