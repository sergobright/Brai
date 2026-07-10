package world.brightos.brai.braicmd

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import world.brightos.brai.capabilities.BraiAccessibilityService

internal enum class QueueRetryTrigger {
    Resume,
    Scheduled,
    Network,
    Manual,
    Enqueue
}

internal data class QueueRetrySchedule(
    val failureCount: Int,
    val nextRetryAtMillis: Long
)

internal fun queueRetryDelayMillis(failureCount: Int): Long {
    val delays = longArrayOf(15_000L, 60_000L, 5 * 60_000L, 15 * 60_000L, 60 * 60_000L)
    return delays[(failureCount.coerceAtLeast(1) - 1).coerceAtMost(delays.lastIndex)]
}

internal class QueueRetryStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val isBlocked: Boolean
        get() = prefs.getBoolean(KEY_BLOCKED, false)

    fun recordTransient(nowMillis: Long): QueueRetrySchedule {
        return recordFailure(nowMillis, blocked = false)
    }

    fun recordBlocked(nowMillis: Long): QueueRetrySchedule {
        return recordFailure(nowMillis, blocked = true)
    }

    private fun recordFailure(nowMillis: Long, blocked: Boolean): QueueRetrySchedule {
        val failureCount = prefs.getInt(KEY_FAILURE_COUNT, 0) + 1
        val schedule = QueueRetrySchedule(
            failureCount = failureCount,
            nextRetryAtMillis = nowMillis + queueRetryDelayMillis(failureCount)
        )
        prefs.edit()
            .putInt(KEY_FAILURE_COUNT, schedule.failureCount)
            .putLong(KEY_NEXT_RETRY_AT, schedule.nextRetryAtMillis)
            .putBoolean(KEY_BLOCKED, blocked)
            .commit()
        return schedule
    }

    fun allowImmediate() {
        prefs.edit()
            .putBoolean(KEY_BLOCKED, false)
            .remove(KEY_NEXT_RETRY_AT)
            .commit()
    }

    fun remainingDelayMillis(nowMillis: Long): Long? {
        return (prefs.getLong(KEY_NEXT_RETRY_AT, 0L) - nowMillis).coerceAtLeast(0L)
    }

    fun reset() {
        prefs.edit().clear().commit()
    }

    private companion object {
        const val PREFS = "brai_cmd_queue_retry"
        const val KEY_FAILURE_COUNT = "failure_count"
        const val KEY_NEXT_RETRY_AT = "next_retry_at"
        const val KEY_BLOCKED = "blocked"
    }
}

internal class OverlayPendingRetry(
    private val service: BraiAccessibilityService,
    private val handler: Handler,
    private val onQueueChanged: (BraiCmdQueueSnapshot) -> Unit = {}
) {
    private val config = ConfigStore(service)
    private val retryStore = QueueRetryStore(service)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var retryRunnable: Runnable? = null
    private var scheduledAtMillis = 0L
    private val settingsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == AppConstants.KEY_AUTH_TOKEN && config.authToken.isNotBlank() &&
            RecordingService.hasPendingRecordings(service)
        ) {
            retryNow()
        }
    }
    private val workerListener: (QueueWorkerResult) -> Unit = { result ->
        handler.post {
            onQueueChanged(result.snapshot)
            when (result.status) {
                QueueWorkerStatus.TransientFailure,
                QueueWorkerStatus.Blocked -> schedule()
                QueueWorkerStatus.Drained -> cancel()
            }
        }
    }

    fun start() {
        RecordingService.addQueueWorkerListener(workerListener)
        config.registerChangeListener(settingsListener)
        registerNetworkRetry()
        onQueueChanged(RecordingService.queueSnapshot(service))
        schedule()
    }

    fun stop() {
        RecordingService.removeQueueWorkerListener(workerListener)
        config.unregisterChangeListener(settingsListener)
        unregisterNetworkRetry()
        cancel()
    }

    /** Returns the delay that was scheduled, 0 for an immediate resume, or null when no retry is needed. */
    fun schedule(nowMillis: Long = System.currentTimeMillis()): Long? {
        if (config.onboardingQueuePaused || !RecordingService.hasPendingRecordings(service)) {
            cancel()
            return null
        }
        retryRunnable?.let { return (scheduledAtMillis - nowMillis).coerceAtLeast(0L) }
        val delay = retryStore.remainingDelayMillis(nowMillis) ?: return null
        if (delay == 0L) {
            RecordingService.retryPending(service, QueueRetryTrigger.Resume)
            return 0L
        }
        scheduledAtMillis = nowMillis + delay
        retryRunnable = Runnable {
            retryRunnable = null
            scheduledAtMillis = 0L
            RecordingService.retryPending(service, QueueRetryTrigger.Scheduled)
        }.also { handler.postDelayed(it, delay) }
        return delay
    }

    fun retryNow(): Boolean {
        cancel()
        return RecordingService.retryPending(service, QueueRetryTrigger.Manual)
    }

    fun cancel() {
        retryRunnable?.let(handler::removeCallbacks)
        retryRunnable = null
        scheduledAtMillis = 0L
    }

    private fun registerNetworkRetry() {
        if (networkCallback != null) return
        val connectivity = service.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                cancel()
                RecordingService.retryPending(service, QueueRetryTrigger.Network)
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
}
