package world.brightos.brai.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

const val DEFAULT_ACTIONS_WIDGET_VIEW_ID = "all"

data class WidgetActionItem(
    val id: String,
    val title: String,
    val status: String
)

data class WidgetActionStatusChange(
    val id: String,
    val actionId: String,
    val status: String,
    val baseServerRevision: Long,
    val occurredAtUtc: String
)

data class WidgetActionsSnapshot(
    val viewId: String,
    val serverRevision: Long,
    val snapshotVersion: Long,
    val actions: List<WidgetActionItem>,
    val hasSnapshot: Boolean
)

class BraiActionsWidgetStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun loadSnapshot(viewId: String = DEFAULT_ACTIONS_WIDGET_VIEW_ID): WidgetActionsSnapshot {
        return synchronized(LOCK) {
            val normalizedViewId = normalizeViewId(viewId)
            val raw = prefs.getString(snapshotKey(normalizedViewId), null) ?: return@synchronized WidgetActionsSnapshot(
                viewId = normalizedViewId,
                serverRevision = 0L,
                snapshotVersion = 0L,
                actions = emptyList(),
                hasSnapshot = false
            )
            applyPending(parseSnapshot(raw, normalizedViewId))
        }
    }

    fun saveSnapshot(viewId: String, serverRevision: Long, snapshotVersion: Long, actions: List<WidgetActionItem>) {
        synchronized(LOCK) {
            val normalizedViewId = normalizeViewId(viewId)
            val currentRaw = prefs.getString(snapshotKey(normalizedViewId), null)
            val currentVersion = currentRaw?.let { parseSnapshot(it, normalizedViewId).snapshotVersion } ?: 0L
            if (snapshotVersion <= currentVersion) return
            val snapshot = WidgetActionsSnapshot(
                viewId = normalizedViewId,
                serverRevision = serverRevision,
                snapshotVersion = snapshotVersion,
                actions = actions,
                hasSnapshot = true
            )
            writeSnapshot(snapshot)
        }
    }

    fun enqueueStatusChange(viewId: String, actionId: String, status: String, baseServerRevision: Long) {
        synchronized(LOCK) {
            if (actionId.isBlank() || !isStatus(status)) return
            val pending = pendingStatusChanges()
                .filterNot { change -> change.actionId == actionId }
                .toMutableList()
            pending.add(
                WidgetActionStatusChange(
                    id = UUID.randomUUID().toString(),
                    actionId = actionId,
                    status = status,
                    baseServerRevision = baseServerRevision,
                    occurredAtUtc = Instant.now().toString()
                )
            )
            writePendingStatusChanges(pending)
        }
    }

    fun pendingStatusChanges(): List<WidgetActionStatusChange> {
        return synchronized(LOCK) {
            val raw = prefs.getString(KEY_PENDING_STATUS_CHANGES, null) ?: return@synchronized emptyList()
            val array = runCatching { JSONArray(raw) }.getOrNull() ?: return@synchronized emptyList()
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val id = item.optString("id").trim()
                    val actionId = item.optString("actionId").trim()
                    val status = item.optString("status").trim()
                    if (id.isBlank() || actionId.isBlank() || !isStatus(status)) continue
                    add(
                        WidgetActionStatusChange(
                            id = id,
                            actionId = actionId,
                            status = status,
                            baseServerRevision = item.optLong("baseServerRevision", 0L),
                            occurredAtUtc = item.optString("occurredAtUtc").ifBlank { Instant.now().toString() }
                        )
                    )
                }
            }
        }
    }

    fun acknowledgeStatusChanges(ids: Set<String>) {
        synchronized(LOCK) {
            if (ids.isEmpty()) return
            writePendingStatusChanges(pendingStatusChanges().filterNot { ids.contains(it.id) })
        }
    }

    fun clear() {
        synchronized(LOCK) {
            prefs.edit().clear().commit()
        }
    }

    private fun applyPending(snapshot: WidgetActionsSnapshot): WidgetActionsSnapshot {
        val pendingByAction = pendingStatusChanges().associateBy { it.actionId }
        if (pendingByAction.isEmpty()) return snapshot
        return snapshot.copy(actions = snapshot.actions.map { action ->
            val pending = pendingByAction[action.id] ?: return@map action
            action.copy(status = pending.status)
        })
    }

    private fun writeSnapshot(snapshot: WidgetActionsSnapshot) {
        prefs.edit().putString(snapshotKey(snapshot.viewId), JSONObject()
            .put("viewId", snapshot.viewId)
            .put("serverRevision", snapshot.serverRevision)
            .put("snapshotVersion", snapshot.snapshotVersion)
            .put("updatedAtUtc", Instant.now().toString())
            .put("actions", JSONArray().also { array ->
                snapshot.actions.forEach { action ->
                    if (action.id.isBlank() || action.title.isBlank() || !isStatus(action.status)) return@forEach
                    array.put(JSONObject()
                        .put("id", action.id)
                        .put("title", action.title)
                        .put("status", action.status))
                }
            })
            .toString()).commit()
    }

    private fun parseSnapshot(raw: String, fallbackViewId: String): WidgetActionsSnapshot {
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return WidgetActionsSnapshot(
            viewId = fallbackViewId,
            serverRevision = 0L,
            snapshotVersion = 0L,
            actions = emptyList(),
            hasSnapshot = false
        )
        val actions = buildList {
            val array = json.optJSONArray("actions") ?: JSONArray()
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val id = item.optString("id").trim()
                val title = item.optString("title").trim()
                val status = item.optString("status").trim()
                if (id.isNotBlank() && title.isNotBlank() && isStatus(status)) {
                    add(WidgetActionItem(id = id, title = title, status = status))
                }
            }
        }
        return WidgetActionsSnapshot(
            viewId = normalizeViewId(json.optString("viewId", fallbackViewId)),
            serverRevision = json.optLong("serverRevision", 0L),
            snapshotVersion = json.optLong("snapshotVersion", 0L),
            actions = actions,
            hasSnapshot = true
        )
    }

    private fun writePendingStatusChanges(changes: List<WidgetActionStatusChange>) {
        prefs.edit().putString(KEY_PENDING_STATUS_CHANGES, JSONArray().also { array ->
            changes.forEach { change ->
                array.put(JSONObject()
                    .put("id", change.id)
                    .put("actionId", change.actionId)
                    .put("status", change.status)
                    .put("baseServerRevision", change.baseServerRevision)
                    .put("occurredAtUtc", change.occurredAtUtc))
            }
        }.toString()).commit()
    }

    private fun snapshotKey(viewId: String): String = "$KEY_SNAPSHOT_PREFIX${normalizeViewId(viewId)}"

    private fun normalizeViewId(viewId: String): String = viewId.trim().ifBlank { DEFAULT_ACTIONS_WIDGET_VIEW_ID }

    private fun isStatus(status: String): Boolean = status == "New" || status == "Done"

    companion object {
        private const val PREFS = "brai_actions_widget"
        private const val KEY_SNAPSHOT_PREFIX = "snapshot:"
        private const val KEY_PENDING_STATUS_CHANGES = "pending_status_changes"
        private val LOCK = Any()
    }
}
