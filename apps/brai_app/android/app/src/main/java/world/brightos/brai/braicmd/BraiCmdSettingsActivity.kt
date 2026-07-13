package world.brightos.brai.braicmd

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import world.brightos.brai.MainActivity

class BraiCmdSettingsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_SECTION, MainActivity.SECTION_BRAI_CMD)
        )
        finish()
    }
}
