package world.brightos.brai.braicmd

import android.content.Context
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout

internal class ContextActionLayerView(context: Context) : FrameLayout(context) {
    var onOutsideTouch: (() -> Unit)? = null
    var onHubTouch: ((MotionEvent) -> Boolean)? = null

    private val touchableChildren = mutableSetOf<View>()
    private val hubBounds = RectF()

    init {
        clipChildren = false
        clipToPadding = false
    }

    fun setTouchable(child: View, touchable: Boolean) {
        if (touchable) touchableChildren += child else touchableChildren -= child
    }

    fun setHubBounds(left: Float, top: Float, size: Float) {
        hubBounds.set(left, top, left + size, top + size)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) {
            onOutsideTouch?.invoke()
            return true
        }
        if (touchableChildren.any { child -> childHit(child, event.x, event.y) }) {
            return super.dispatchTouchEvent(event)
        }
        if (hubBounds.contains(event.x, event.y)) {
            return onHubTouch?.invoke(event) ?: true
        }
        if (event.actionMasked == MotionEvent.ACTION_DOWN) onOutsideTouch?.invoke()
        return true
    }

    private fun childHit(child: View, x: Float, y: Float): Boolean =
        child.visibility == View.VISIBLE &&
            child.isEnabled &&
            x >= child.left + child.translationX &&
            x <= child.right + child.translationX &&
            y >= child.top + child.translationY &&
            y <= child.bottom + child.translationY
}
