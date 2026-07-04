package world.brightos.brai.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.ToggleableStateKey
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import world.brightos.brai.R

class BraiActionsWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = BraiActionsWidget
}

class ToggleBraiActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val actionId = parameters[ActionIdKey]?.trim().orEmpty()
        val checked = parameters[ToggleableStateKey]
        val nextStatus = when (checked) {
            true -> "Done"
            false -> "New"
            null -> parameters[NextStatusKey]?.trim().orEmpty()
        }
        val revision = parameters[RevisionKey]?.toLongOrNull() ?: 0L
        if (actionId.isBlank() || nextStatus !in setOf("New", "Done")) return
        withContext(Dispatchers.IO) {
            BraiActionsWidgetStore(context).enqueueStatusChange(
                viewId = DEFAULT_ACTIONS_WIDGET_VIEW_ID,
                actionId = actionId,
                status = nextStatus,
                baseServerRevision = revision
            )
        }
        BraiActionsWidget.updateEveryInstance(context, glanceId)
    }
}

object BraiActionsWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Single

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val state = withContext(Dispatchers.IO) { loadWidgetState(context) }
        provideContent {
            BraiActionsWidgetContent(state)
        }
    }

    suspend fun updateEveryInstance(context: Context, first: GlanceId? = null) {
        if (first != null) update(context, first)
        GlanceAppWidgetManager(context)
            .getGlanceIds(BraiActionsWidget::class.java)
            .filter { glanceId -> glanceId != first }
            .forEach { glanceId -> update(context, glanceId) }
    }
}

@Composable
private fun BraiActionsWidgetContent(state: WidgetState) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(ColorProvider(R.color.brai_widget_background))
            .padding(12.dp)
    ) {
        Text(
            text = "Actions",
            style = TextStyle(
                color = ColorProvider(R.color.brai_widget_text),
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold
            )
        )
        if (state.message != null) {
            Text(
                text = state.message,
                style = TextStyle(
                    color = ColorProvider(R.color.brai_widget_muted),
                    fontSize = 12.sp
                )
            )
            return@Column
        }
        if (state.actions.isEmpty()) {
            Text(
                text = "Нет действий",
                style = TextStyle(
                    color = ColorProvider(R.color.brai_widget_muted),
                    fontSize = 12.sp
                )
            )
            return@Column
        }
        state.actions.take(MAX_WIDGET_ACTIONS).forEach { action ->
            key(action.id) {
                val checked = action.status == "Done"
                CheckBox(
                    checked = checked,
                    onCheckedChange = actionRunCallback(
                        ToggleBraiActionCallback::class.java,
                        actionParametersOf(
                            ActionIdKey to action.id,
                            NextStatusKey to if (checked) "New" else "Done",
                            RevisionKey to state.serverRevision.toString()
                        )
                    ),
                    text = action.title,
                    style = TextStyle(
                        color = ColorProvider(R.color.brai_widget_text),
                        fontSize = 12.sp
                    ),
                    maxLines = 1
                )
            }
        }
    }
}

private fun loadWidgetState(context: Context): WidgetState =
    BraiActionsWidgetStore(context).loadSnapshot(DEFAULT_ACTIONS_WIDGET_VIEW_ID).let { snapshot ->
        WidgetState(
            serverRevision = snapshot.serverRevision,
            actions = snapshot.actions,
            message = if (snapshot.hasSnapshot) null else "Откройте Brai"
        )
    }

private data class WidgetState(
    val serverRevision: Long,
    val actions: List<WidgetActionItem>,
    val message: String?
)

private val ActionIdKey = ActionParameters.Key<String>("action_id")
private val NextStatusKey = ActionParameters.Key<String>("next_status")
private val RevisionKey = ActionParameters.Key<String>("server_revision")
private const val MAX_WIDGET_ACTIONS = 8
