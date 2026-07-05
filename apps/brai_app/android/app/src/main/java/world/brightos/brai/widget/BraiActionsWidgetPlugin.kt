package world.brightos.brai.widget

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@CapacitorPlugin(name = "BraiActionsWidget")
class BraiActionsWidgetPlugin : Plugin() {
    private val pluginScope = CoroutineScope(Dispatchers.Main)

    override fun load() {
        activePlugin = this
    }

    override fun handleOnDestroy() {
        if (activePlugin === this) activePlugin = null
        super.handleOnDestroy()
    }

    @PluginMethod
    fun saveSnapshot(call: PluginCall) {
        val viewId = call.getString("viewId", DEFAULT_ACTIONS_WIDGET_VIEW_ID) ?: DEFAULT_ACTIONS_WIDGET_VIEW_ID
        val serverRevision = call.getLong("serverRevision", 0L) ?: 0L
        val snapshotVersion = call.getLong("snapshotVersion", 0L) ?: 0L
        val actionsArray = call.getArray("actions", JSArray()) ?: JSArray()
        val actions = buildList {
            for (index in 0 until actionsArray.length()) {
                val item = actionsArray.optJSONObject(index) ?: continue
                val id = item.optString("id").trim()
                val title = item.optString("title").trim()
                val status = item.optString("status").trim()
                if (id.isNotBlank() && title.isNotBlank() && (status == "New" || status == "Done")) {
                    add(WidgetActionItem(id = id, title = title, status = status))
                }
            }
        }
        pluginScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    BraiActionsWidgetStore(context).saveSnapshot(viewId, serverRevision, snapshotVersion, actions)
                }
                BraiActionsWidget.updateEveryInstanceNowAndSoon(context)
                call.resolve()
            } catch (error: Exception) {
                call.reject("widget_update_failed", error)
            }
        }
    }

    @PluginMethod
    fun pendingStatusChanges(call: PluginCall) {
        val result = JSObject()
        val array = JSArray()
        BraiActionsWidgetStore(context).pendingStatusChanges().forEach { change ->
            array.put(JSObject()
                .put("id", change.id)
                .put("actionId", change.actionId)
                .put("status", change.status)
                .put("baseServerRevision", change.baseServerRevision)
                .put("occurredAtUtc", change.occurredAtUtc))
        }
        result.put("changes", array)
        call.resolve(result)
    }

    @PluginMethod
    fun acknowledgeStatusChanges(call: PluginCall) {
        val ids = (call.getArray("ids", JSArray()) ?: JSArray()).let { array ->
            buildSet {
                for (index in 0 until array.length()) {
                    val id = array.optString(index).trim()
                    if (id.isNotBlank()) add(id)
                }
            }
        }
        if (ids.isEmpty()) {
            call.resolve()
            return
        }
        pluginScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    BraiActionsWidgetStore(context).acknowledgeStatusChanges(ids)
                }
                BraiActionsWidget.updateEveryInstanceNowAndSoon(context)
                call.resolve()
            } catch (error: Exception) {
                call.reject("widget_acknowledge_failed", error)
            }
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        pluginScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    BraiActionsWidgetStore(context).clear()
                }
                BraiActionsWidget.updateEveryInstanceNowAndSoon(context)
                call.resolve()
            } catch (error: Exception) {
                call.reject("widget_clear_failed", error)
            }
        }
    }

    private fun notifyStatusChangesPendingNow() {
        notifyListeners(EVENT_STATUS_CHANGES_PENDING, JSObject())
    }

    companion object {
        private const val EVENT_STATUS_CHANGES_PENDING = "statusChangesPending"

        @Volatile
        private var activePlugin: BraiActionsWidgetPlugin? = null

        fun notifyStatusChangesPending() {
            val plugin = activePlugin ?: return
            plugin.pluginScope.launch {
                plugin.notifyStatusChangesPendingNow()
            }
        }
    }
}
