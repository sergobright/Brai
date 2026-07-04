package world.brightos.brai.widget

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class BraiActionsWidgetInstrumentedTest {
    @Test
    fun updatesLauncherWidgetsFromOfflineSnapshot() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = BraiActionsWidgetStore(context)
        val actions = listOf(
            WidgetActionItem("widget-action-one", "Виджет один", "New"),
            WidgetActionItem("widget-action-two", "Виджет два", "New"),
            WidgetActionItem("widget-action-done", "Виджет готово", "Done"),
        )

        store.clear()
        store.enqueueStatusChange(DEFAULT_ACTIONS_WIDGET_VIEW_ID, "widget-action-one", "Done", 501L)
        store.enqueueStatusChange(DEFAULT_ACTIONS_WIDGET_VIEW_ID, "widget-action-one", "New", 501L)
        assertEquals("New", store.pendingStatusChanges().single().status)

        store.clear()
        store.saveSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID, serverRevision = 501L, snapshotVersion = 501_000L, actions)
        BraiActionsWidget.updateEveryInstanceNowAndSoon(context)

        val saved = store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID)
        assertEquals(actions, saved.actions)
    }
}
