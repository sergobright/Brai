package world.brightos.brai.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.currentState
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
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.background
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.delay
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
        BraiActionsWidgetPlugin.notifyStatusChangesPending()
        BraiActionsWidget.updateEveryInstanceNowAndSoon(context, glanceId)
    }
}

object BraiActionsWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Single
    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            key(currentState<Preferences>()[WidgetInvalidationKey] ?: 0L) {
                BraiActionsWidgetContent(loadWidgetState(context))
            }
        }
    }

    suspend fun updateEveryInstance(context: Context, first: GlanceId? = null) {
        val glanceIds = GlanceAppWidgetManager(context)
            .getGlanceIds(BraiActionsWidget::class.java)
        val orderedIds = buildList {
            if (first != null) add(first)
            addAll(glanceIds.filter { glanceId -> glanceId != first })
        }
        orderedIds.forEach { glanceId ->
            updateAppWidgetState(context, glanceId) { preferences ->
                preferences[WidgetInvalidationKey] = System.nanoTime()
            }
            update(context, glanceId)
        }
    }

    suspend fun updateEveryInstanceNowAndSoon(context: Context, first: GlanceId? = null) {
        updateEveryInstance(context, first)
        delay(350)
        updateEveryInstance(context)
    }
}

@Composable
private fun BraiActionsWidgetContent(state: WidgetState) {
    LazyColumn(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(ColorProvider(R.color.brai_widget_background))
            .padding(12.dp)
    ) {
        item {
            Text(
                text = "Actions",
                style = TextStyle(
                    color = ColorProvider(R.color.brai_widget_text),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
            )
        }
        if (state.message != null) {
            item {
                Text(
                    text = state.message,
                    style = TextStyle(
                        color = ColorProvider(R.color.brai_widget_muted),
                        fontSize = 12.sp
                    )
                )
            }
            return@LazyColumn
        }
        if (state.actions.isEmpty()) {
            item {
                Text(
                    text = "Нет действий",
                    style = TextStyle(
                        color = ColorProvider(R.color.brai_widget_muted),
                        fontSize = 12.sp
                    )
                )
            }
            return@LazyColumn
        }
        items(state.actions) { action ->
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
private val WidgetInvalidationKey = longPreferencesKey("widget_invalidation")
