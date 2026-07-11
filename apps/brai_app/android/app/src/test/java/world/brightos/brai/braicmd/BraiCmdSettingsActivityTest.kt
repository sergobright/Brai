package world.brightos.brai.braicmd

import android.view.View
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BraiCmdSettingsActivityTest {
    @Test
    fun `legacy name access controls are absent`() {
        val activity = Robolectric.buildActivity(BraiCmdSettingsActivity::class.java).setup().get()
        val matches = ArrayList<View>()

        activity.window.decorView.findViewsWithText(matches, "Имя для статистики", View.FIND_VIEWS_WITH_TEXT)
        activity.window.decorView.findViewsWithText(matches, "Получить доступ", View.FIND_VIEWS_WITH_TEXT)

        assertTrue(matches.isEmpty())
    }
}
