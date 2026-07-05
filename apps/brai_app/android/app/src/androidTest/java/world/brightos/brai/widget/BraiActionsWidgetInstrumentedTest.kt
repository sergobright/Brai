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
        store.saveSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID, serverRevision = 501L, snapshotVersion = 501_000L, actions = actions)
        BraiActionsWidget.updateEveryInstanceNowAndSoon(context)

        val saved = store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID)
        assertEquals(actions, saved.actions)
    }

    @Test
    fun widgetPendingStatusDoesNotBlockNewAppSnapshot() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = BraiActionsWidgetStore(context)
        val firstSnapshot = listOf(
            WidgetActionItem("widget-action-one", "Виджет один", "New"),
        )
        val appSnapshotAfterWidgetTap = listOf(
            WidgetActionItem("widget-action-one", "Виджет один", "Done"),
            WidgetActionItem("widget-action-two", "Виджет два", "New"),
        )

        store.clear()
        store.saveSnapshot(
            DEFAULT_ACTIONS_WIDGET_VIEW_ID,
            serverRevision = 501L,
            snapshotVersion = 501_000L,
            actions = firstSnapshot,
        )
        store.enqueueStatusChange(DEFAULT_ACTIONS_WIDGET_VIEW_ID, "widget-action-one", "Done", 501L)

        assertEquals("Done", store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID).actions.single().status)

        store.saveSnapshot(
            DEFAULT_ACTIONS_WIDGET_VIEW_ID,
            serverRevision = 502L,
            snapshotVersion = 501_001L,
            actions = appSnapshotAfterWidgetTap,
        )
        val pendingIds = store.pendingStatusChanges().map { change -> change.id }.toSet()
        store.acknowledgeStatusChanges(pendingIds)

        val saved = store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID)
        assertEquals(appSnapshotAfterWidgetTap, saved.actions)
    }
}
