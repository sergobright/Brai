package world.brightos.brai.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class BraiActionsWidgetStoreTest {
    private lateinit var store: BraiActionsWidgetStore

    @Before
    fun setUp() {
        store = BraiActionsWidgetStore(RuntimeEnvironment.getApplication())
        store.clear()
    }

    @Test
    fun savesAndLoadsSnapshot() {
        val actions = listOf(
            WidgetActionItem("action-one", "Action one", "New"),
            WidgetActionItem("action-two", "Action two", "Done"),
        )

        store.saveSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID, serverRevision = 10L, snapshotVersion = 100L, actions)

        val saved = store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID)
        assertTrue(saved.hasSnapshot)
        assertEquals(10L, saved.serverRevision)
        assertEquals(100L, saved.snapshotVersion)
        assertEquals(actions, saved.actions)
    }

    @Test
    fun appliesAndAcknowledgesPendingStatusChanges() {
        store.saveSnapshot(
            DEFAULT_ACTIONS_WIDGET_VIEW_ID,
            serverRevision = 20L,
            snapshotVersion = 200L,
            listOf(WidgetActionItem("action-one", "Action one", "New")),
        )
        store.enqueueStatusChange(DEFAULT_ACTIONS_WIDGET_VIEW_ID, "action-one", "Done", 20L)

        val pending = store.pendingStatusChanges()
        assertEquals(1, pending.size)
        assertEquals("Done", store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID).actions.single().status)

        store.acknowledgeStatusChanges(pending.map { it.id }.toSet())

        assertTrue(store.pendingStatusChanges().isEmpty())
        assertEquals("New", store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID).actions.single().status)
    }

    @Test
    fun keepsNewestServerRevision() {
        val oldActions = listOf(WidgetActionItem("old-action", "Old", "New"))
        val latestActions = listOf(WidgetActionItem("latest-action", "Latest", "Done"))

        store.saveSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID, serverRevision = 30L, snapshotVersion = 300L, oldActions)
        store.saveSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID, serverRevision = 31L, snapshotVersion = 1L, latestActions)
        store.saveSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID, serverRevision = 30L, snapshotVersion = 999L, oldActions)

        val saved = store.loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID)
        assertEquals(31L, saved.serverRevision)
        assertEquals(1L, saved.snapshotVersion)
        assertEquals(latestActions, saved.actions)
        assertFalse(saved.actions.contains(oldActions.single()))
    }
}
