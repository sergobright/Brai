package world.brightos.brai.braicmd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ConfigStoreTest {
    private lateinit var store: ConfigStore

    @Before
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        store = ConfigStore(context)
    }

    @Test
    fun secondaryContextButtonsDefaultEnabled() {
        assertTrue(store.contextActionIdeaEnabled)
        assertTrue(store.contextActionScreenshotEnabled)
        assertTrue(store.contextActionScreenshotVoiceEnabled)
        assertTrue(store.contextActionChatEnabled)
        assertTrue(store.contextActionSaveEnabled)
    }

    @Test
    fun secondaryContextButtonsPersistToggles() {
        store.contextActionIdeaEnabled = false
        store.contextActionScreenshotEnabled = false
        store.contextActionScreenshotVoiceEnabled = false
        store.contextActionChatEnabled = false
        store.contextActionSaveEnabled = false

        val reloaded = ConfigStore(RuntimeEnvironment.getApplication())

        assertFalse(reloaded.contextActionIdeaEnabled)
        assertFalse(reloaded.contextActionScreenshotEnabled)
        assertFalse(reloaded.contextActionScreenshotVoiceEnabled)
        assertFalse(reloaded.contextActionChatEnabled)
        assertFalse(reloaded.contextActionSaveEnabled)
    }
}
