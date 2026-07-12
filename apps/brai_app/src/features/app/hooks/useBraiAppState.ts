"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { BraiApi, DEFAULT_APP_SETTINGS, type AppSettings, type OtpSendResult } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import {
  acknowledgeAndroidActionsWidgetStatusChanges,
  clearAndroidActionsWidgetData,
  DEFAULT_ACTIONS_WIDGET_VIEW_ID,
  listenAndroidActionsWidgetStatusChangesPending,
  pendingAndroidActionsWidgetStatusChanges,
  saveAndroidActionsWidgetSnapshot,
} from "@/shared/platform/androidActionsWidget";
import { consumeAndroidTimerStopRequest, startAndroidTimerNotification, stopAndroidTimerNotification } from "@/shared/platform/androidTimerNotification";
import { isNativeShell, platformName } from "@/shared/platform/platform";
import { acknowledgeActionEvents, enqueueActivityEvent, loadActionsState, markActionAttempt, markActionFailure, pendingActionEvents, projectActionsState, saveActionsState } from "@/shared/storage/activityStore";
import { ensureClientMeta, ensureClientUser } from "@/shared/storage/db";
import { acknowledgeInboxEvents, loadInboxState, markInboxAttempt, markInboxFailure, pendingInboxEvents, projectInboxState, saveInboxState } from "@/shared/storage/inboxStore";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import { projectHistoryData, projectTimerState } from "@/shared/storage/projection";
import { acknowledgeEvents, enqueueFocusIntervalEdit, enqueueFocusSessionDelete, enqueueFocusSessionEdit, enqueueStartActionFocus, enqueueStopActionFocus, enqueueSwitchActionFocus, enqueueTimerEvent, loadCanonicalState, loadGoalCache, loadHistoryCache, markAttempt, markFailure, pendingEvents, saveCanonicalState, saveGoalCache, saveHistoryCache, saveIgnoredEvents } from "@/shared/storage/syncStore";
import { setDisplayTimeZone, tickTimerState } from "@/shared/time/format";
import type { ActionsState } from "@/shared/types/activities";
import { emptyActionsState } from "@/shared/types/activities";
import type { InboxState } from "@/shared/types/inbox";
import { emptyInboxState } from "@/shared/types/inbox";
import type { GoalData, HistoryData, SyncStatus, TimerState } from "@/shared/types/timer";
import { emptyGoal, emptyHistory, emptyTimerState } from "@/shared/types/timer";
import type { FocusBackgroundMode, FocusContextPanel, MobileContextPanel, SectionId } from "../appModel";
import { FOCUS_BACKGROUND_STORAGE_KEY, FOCUS_CONTEXT_PANEL_STORAGE_KEY, sectionFromLocation, syncSectionUrl } from "../appModel";
import { moscowTodayKey, normalizeHistory } from "../appUtils";
import { isMobileNavigationViewport, useMobileNavigationViewport, useSectionSwipeNavigation } from "../navigation/useSectionSwipeNavigation";
import { createBraiActionCommands } from "./useBraiActionCommands";
import { createBraiInboxCommands } from "./useBraiInboxCommands";
import { useBraiLiveUpdates } from "./useBraiLiveUpdates";
import { useBraiOta } from "./useBraiOta";
import { useBraiTheme } from "./useBraiTheme";
import { useBraiVersion } from "./useBraiVersion";

const ANDROID_ACTIONS_WIDGET_STATUS_POLL_MS = 250;
const ANDROID_ACTIONS_WIDGET_SNAPSHOT_DEBOUNCE_MS = 75;
const APP_SETTINGS_STORAGE_KEY = "brai_app_settings";

/**
 * Owns the Brai client state machine, local cache loading, and sync flow.
 */
export function useBraiAppState(initialSection: SectionId) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const { setTheme, theme } = useBraiTheme();
  const { bundlePublishedAt, otaCheckedAt, otaRefreshing, otaState, refreshOtaStateOnce } =
    useBraiOta();
  const [appSettings, setAppSettingsState] = useState<AppSettings>(loadAppSettingsPreference);
  const [todayKey, setTodayKey] = useState(() => moscowTodayKey());
  const [apiBase, setApiBase] = useState(defaultApiBase());
  const api = useMemo(() => new BraiApi(apiBase), [apiBase]);
  const { refreshVersionOnce, versionCheckedAt, versionError, versionRefreshing, versionState } = useBraiVersion(api);
  const apiRef = useRef(api);
  const refreshAllRef = useRef<(sourceApi?: BraiApi) => Promise<void>>(async () => undefined);
  const refreshStateAndFlushRef = useRef<() => Promise<void>>(async () => undefined);
  const applyServerStateRef = useRef<(state: TimerState) => Promise<void>>(async () => undefined);
  const applyActivitiesStateRef = useRef<(state: ActionsState) => Promise<void>>(async () => undefined);
  const applyInboxStateRef = useRef<(state: InboxState) => Promise<void>>(async () => undefined);
  const consumeAndroidActionsWidgetStatusChangesRef = useRef<() => Promise<void>>(async () => undefined);
  const timerRevisionRef = useRef(0);
  const actionsRevisionRef = useRef(0);
  const inboxRevisionRef = useRef(0);
  const historyGoalRevisionRef = useRef(0);
  const activeRef = useRef(false);
  const androidStopInFlightRef = useRef(false);
  const androidWidgetStatusInFlightRef = useRef(false);
  const androidActionsSnapshotVersionRef = useRef(0);
  const androidActionsSnapshotLatestRef = useRef<ActionsState | null>(null);
  const androidActionsSnapshotTimerRef = useRef<number | null>(null);
  const actionFlushInFlightRef = useRef(false);
  const actionFlushQueuedRef = useRef(false);
  const timerFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimerRef = useRef<() => Promise<void>>(async () => undefined);
  const [timer, setTimer] = useState<TimerState>(() => emptyTimerState());
  const [actions, setActions] = useState<ActionsState>(() => emptyActionsState());
  const actionsRef = useRef<ActionsState>(actions);
  const [inbox, setInbox] = useState<InboxState>(() => emptyInboxState());
  const [history, setHistory] = useState<HistoryData>(() => emptyHistory());
  const [goal, setGoal] = useState<GoalData>(() => emptyGoal());
  const [localSnapshotReady, setLocalSnapshotReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [pendingCount, setPendingCount] = useState(0);
  const [actionPendingCount, setActionPendingCount] = useState(0);
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const authDisplayNameRef = useRef("");
  const [timerBusy, setTimerBusy] = useState(false);
  const [actionOverlayOpen, setActionOverlayOpen] = useState(false);
  const [focusContextPanel, setFocusContextPanel] = useState<FocusContextPanel>(loadFocusContextPanelPreference);
  const [focusBackground, setFocusBackgroundState] = useState<FocusBackgroundMode>(loadFocusBackgroundPreference);
  const [mobileContextPanel, setMobileContextPanel] = useState<MobileContextPanel | null>(null);
  const [mobileContextPanelClosing, setMobileContextPanelClosing] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileViewport = useMobileNavigationViewport();

  function applyAppSettings(settings: AppSettings) {
    setDisplayTimeZone(settings.display_timezone);
    setAppSettingsState(settings);
    setTodayKey(moscowTodayKey());
    saveAppSettingsPreference(settings);
  }

  function setTimerSnapshot(nextState: TimerState) {
    setTimer((current) => (current.server_revision > nextState.server_revision ? current : nextState));
  }

  function setActionsAndRef(nextState: SetStateAction<ActionsState>) {
    const resolved = typeof nextState === "function"
      ? (nextState as (current: ActionsState) => ActionsState)(actionsRef.current)
      : nextState;
    actionsRef.current = resolved;
    setActions(resolved);
  }

  function setActionsSnapshot(nextState: ActionsState) {
    if (actionsRef.current.server_revision > nextState.server_revision) return;
    setActionsAndRef(nextState);
  }

  async function setProjectedActionsSnapshot(canonical: ActionsState) {
    const queuedActions = await pendingActionEvents();
    setActionsSnapshot(projectActionsState(canonical, queuedActions));
    setActionPendingCount(queuedActions.length);
    return queuedActions;
  }

  function setInboxSnapshot(nextState: InboxState) {
    setInbox((current) => (current.server_revision > nextState.server_revision ? current : nextState));
  }

  async function applyServerState(state: TimerState) {
    const queued = await pendingEvents();
    if (queued.length > 0) {
      await flushPending();
      return;
    }
    if (state.server_revision < timerRevisionRef.current) return;
    timerRevisionRef.current = state.server_revision;
    const accepted = await saveCanonicalState(state);
    if (!accepted) return;
    setTimerSnapshot(tickTimerState(state));
    setSyncStatus("synced");
    if (state.server_revision > historyGoalRevisionRef.current) {
      try {
        await refreshHistoryAndGoal(apiRef.current, state.server_revision);
      } catch (error) {
        handleError(error);
      }
    }
  }

  async function applyActivitiesState(state: ActionsState) {
    const queued = await pendingActionEvents();
    if (queued.length > 0) {
      await flushActionPending();
      return;
    }
    if (state.server_revision < actionsRevisionRef.current) return;
    actionsRevisionRef.current = state.server_revision;
    const accepted = await saveActionsState(state);
    if (!accepted) return;
    const latestQueuedActions = await setProjectedActionsSnapshot(state);
    const [timerQueued, inboxQueued] = await Promise.all([pendingEvents(), pendingInboxEvents()]);
    setSyncStatus(latestQueuedActions.length + timerQueued.length + inboxQueued.length > 0 ? "pending_sync" : "synced");
  }

  async function applyInboxState(state: InboxState) {
    const queued = await pendingInboxEvents();
    if (queued.length > 0) {
      await flushInboxPending();
      return;
    }
    if (state.server_revision < inboxRevisionRef.current) return;
    inboxRevisionRef.current = state.server_revision;
    const accepted = await saveInboxState(state);
    if (!accepted) return;
    setInboxSnapshot(projectInboxState(state, []));
    setInboxPendingCount(0);
    setSyncStatus("synced");
  }

  async function refreshStateAndFlush() {
    try {
      const state = await apiRef.current.state();
      await applyServerState(state);
      await flushPending();
      await refreshActionsAndFlush();
      await refreshInboxAndFlush();
    } catch (error) {
      handleError(error);
    }
  }

  async function refreshAll(sourceApi = apiRef.current) {
    setBusy(true);
    try {
      const [nextSettings, nextState, nextHistory, nextGoal, nextActions, nextInbox] = await Promise.all([
        sourceApi.settings(),
        sourceApi.state(),
        sourceApi.history(),
        sourceApi.goal(),
        sourceApi.actions(),
        sourceApi.inbox(),
      ]);
      applyAppSettings(nextSettings);
      const [queued, queuedInbox] = await Promise.all([pendingEvents(), pendingInboxEvents()]);
      let queuedActions = await pendingActionEvents();
      const accepted =
        nextState.server_revision >= timerRevisionRef.current && (await saveCanonicalState(nextState));
      if (accepted) {
        const normalizedHistory = normalizeHistory(nextHistory);
        await Promise.all([
          saveHistoryCache(normalizedHistory),
          saveGoalCache(nextGoal, nextState.server_revision),
        ]);
        timerRevisionRef.current = nextState.server_revision;
        historyGoalRevisionRef.current = nextState.server_revision;
        setTimerSnapshot(projectTimerState(nextState, queued));
        setHistory(projectHistoryData(normalizedHistory, queued));
        setGoal(nextGoal);
      }
      const actionsAccepted =
        nextActions.server_revision >= actionsRevisionRef.current && (await saveActionsState(nextActions));
      if (actionsAccepted) {
        actionsRevisionRef.current = nextActions.server_revision;
        queuedActions = await setProjectedActionsSnapshot(nextActions);
      }
      const inboxAccepted =
        nextInbox.server_revision >= inboxRevisionRef.current && (await saveInboxState(nextInbox));
      if (inboxAccepted) {
        inboxRevisionRef.current = nextInbox.server_revision;
        setInboxSnapshot(projectInboxState(nextInbox, queuedInbox));
      }
      setPendingCount(queued.length);
      setActionPendingCount(queuedActions.length);
      setInboxPendingCount(queuedInbox.length);
      setSyncStatus(queued.length + queuedActions.length + queuedInbox.length > 0 ? "pending_sync" : "synced");
      await flushPending(sourceApi);
      await flushActionPending(sourceApi);
      await flushInboxPending(sourceApi);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function flushPending(sourceApi = apiRef.current) {
    const queued = await pendingEvents();
    setPendingCount(queued.length);
    if (queued.length === 0) {
      if ((await pendingActionEvents()).length + (await pendingInboxEvents()).length === 0) setSyncStatus("synced");
      return;
    }

    setSyncStatus("pending_sync");
    await markAttempt(queued);
    try {
      const meta = await ensureClientMeta();
      const response = await sourceApi.syncEvents({
        deviceId: meta.deviceId,
        platform: meta.platform,
        events: queued,
        lastKnownServerTimeUtc: timer.server_time_utc,
      });
      const ignoredIds = response.ignored_events.map((event) => event.event_id);
      await acknowledgeEvents([...response.acknowledged_event_ids, ...ignoredIds]);
      await saveIgnoredEvents(response.ignored_events);
      const accepted =
        response.state.server_revision >= timerRevisionRef.current && (await saveCanonicalState(response.state));
      const remaining = await pendingEvents();
      const currentState = accepted ? response.state : (await loadCanonicalState()) ?? response.state;
      if (currentState.server_revision >= timerRevisionRef.current) {
        timerRevisionRef.current = currentState.server_revision;
        setTimerSnapshot(projectTimerState(currentState, remaining));
      }
      setPendingCount(remaining.length);
      const [actionQueued, inboxQueued] = await Promise.all([pendingActionEvents(), pendingInboxEvents()]);
      setSyncStatus(remaining.length + actionQueued.length + inboxQueued.length > 0 ? "pending_sync" : "synced");

      if (accepted) {
        await refreshHistoryAndGoal(sourceApi, response.server_revision);
      }
    } catch (error) {
      await markFailure(queued, error instanceof Error ? error.message : "sync_failed");
      handleError(error);
    }
  }

  function flushPendingSoon() {
    if (timerFlushTimeoutRef.current) return;
    timerFlushTimeoutRef.current = setTimeout(() => {
      timerFlushTimeoutRef.current = null;
      void flushPending().catch(handleError);
    }, 0);
  }

  async function refreshHistoryAndGoal(sourceApi = apiRef.current, serverRevision = timer.server_revision) {
    if (serverRevision < historyGoalRevisionRef.current) return;
    const [nextHistory, nextGoal] = await Promise.all([sourceApi.history(), sourceApi.goal()]);
    if (serverRevision < historyGoalRevisionRef.current) return;
    const normalizedHistory = normalizeHistory(nextHistory);
    await Promise.all([
      saveHistoryCache(normalizedHistory),
      saveGoalCache(nextGoal, serverRevision),
    ]);
    historyGoalRevisionRef.current = serverRevision;
    setHistory(projectHistoryData(normalizedHistory, await pendingEvents()));
    setGoal(nextGoal);
  }

  async function updateAppSettings(patch: Parameters<BraiApi["updateSettings"]>[0]) {
    setBusy(true);
    try {
      const nextSettings = await apiRef.current.updateSettings(patch);
      applyAppSettings(nextSettings);
      setTimer((current) => ({ ...current, timezone: nextSettings.display_timezone }));
      await refreshHistoryAndGoal(apiRef.current, timerRevisionRef.current);
    } catch (error) {
      handleError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function refreshActionsAndFlush(sourceApi = apiRef.current) {
    try {
      const nextActions = await sourceApi.actions();
      let queuedActions = await pendingActionEvents();
      const accepted =
        nextActions.server_revision >= actionsRevisionRef.current && (await saveActionsState(nextActions));
      if (accepted) {
        actionsRevisionRef.current = nextActions.server_revision;
        queuedActions = await setProjectedActionsSnapshot(nextActions);
      }
      setActionPendingCount(queuedActions.length);
      await flushActionPending(sourceApi);
    } catch (error) {
      handleError(error);
    }
  }

  async function flushActionPending(sourceApi = apiRef.current) {
    if (actionFlushInFlightRef.current) {
      actionFlushQueuedRef.current = true;
      return;
    }
    actionFlushInFlightRef.current = true;
    try {
      do {
        actionFlushQueuedRef.current = false;
        await flushActionPendingOnce(sourceApi);
      } while (actionFlushQueuedRef.current);
    } finally {
      actionFlushInFlightRef.current = false;
    }
  }

  async function flushActionPendingOnce(sourceApi = apiRef.current) {
    const queued = await pendingActionEvents();
    setActionPendingCount(queued.length);
    if (queued.length === 0) {
      if ((await pendingEvents()).length + (await pendingInboxEvents()).length === 0) setSyncStatus("synced");
      return;
    }

    setSyncStatus("pending_sync");
    await markActionAttempt(queued);
    try {
      const meta = await ensureClientMeta();
      const response = await sourceApi.syncActionEvents({
        deviceId: meta.deviceId,
        platform: meta.platform,
        events: queued,
        lastKnownServerTimeUtc: actionsRef.current.server_time_utc,
      });
      const ignoredIds = response.ignored_events.map((event) => event.event_id);
      await acknowledgeActionEvents([...response.acknowledged_event_ids, ...ignoredIds]);
      await saveIgnoredEvents(response.ignored_events);
      const accepted =
        response.state.server_revision >= actionsRevisionRef.current && (await saveActionsState(response.state));
      const remaining = await pendingActionEvents();
      let projected: ActionsState | null = null;
      if (accepted) {
        actionsRevisionRef.current = response.state.server_revision;
        projected = projectActionsState(response.state, remaining);
      } else {
        const cachedState = await loadActionsState();
        if (cachedState && cachedState.server_revision > actionsRevisionRef.current) {
          actionsRevisionRef.current = cachedState.server_revision;
          projected = projectActionsState(cachedState, remaining);
        } else {
          projected = projectActionsState(actionsRef.current, remaining);
        }
      }
      if (projected) {
        setActionsAndRef(projected);
        requestAndroidActionsSnapshotPublish(projected);
      }
      setActionPendingCount(remaining.length);
      const [timerQueued, inboxQueued] = await Promise.all([pendingEvents(), pendingInboxEvents()]);
      setSyncStatus(remaining.length + timerQueued.length + inboxQueued.length > 0 ? "pending_sync" : "synced");
    } catch (error) {
      await markActionFailure(queued, error instanceof Error ? error.message : "sync_failed");
      handleError(error);
    }
  }

  async function consumeAndroidActionsWidgetStatusChanges() {
    if (androidWidgetStatusInFlightRef.current) return;
    androidWidgetStatusInFlightRef.current = true;
    try {
      const changes = await pendingAndroidActionsWidgetStatusChanges();
      if (changes.length === 0) return;

      const currentActions = actionsRef.current;
      const statusById = new Map(currentActions.actions.map((action) => [action.id, action.status]));
      const acknowledgedIds: string[] = [];
      let enqueued = false;
      for (const change of changes) {
        const currentStatus = statusById.get(change.actionId);
        if (!currentStatus || currentStatus === change.status) {
          acknowledgedIds.push(change.id);
          continue;
        }
        await enqueueActivityEvent({
          type: "set_status",
          actionId: change.actionId,
          payload: { status: change.status },
          baseServerRevision: currentActions.server_revision,
        });
        statusById.set(change.actionId, change.status);
        acknowledgedIds.push(change.id);
        enqueued = true;
      }

      const queued = await pendingActionEvents();
      const canonical = await loadActionsState();
      const projected = projectActionsState(canonical ?? currentActions, queued);
      setActionsAndRef(projected);
      await publishAndroidActionsSnapshot(projected);
      await acknowledgeAndroidActionsWidgetStatusChanges(acknowledgedIds);
      if (!enqueued) return;

      setActionPendingCount(queued.length);
      setSyncStatus("pending_sync");
      await flushActionPending();
    } finally {
      androidWidgetStatusInFlightRef.current = false;
    }
  }

  async function refreshInboxAndFlush(sourceApi = apiRef.current) {
    try {
      const nextInbox = await sourceApi.inbox();
      const queuedInbox = await pendingInboxEvents();
      const accepted =
        nextInbox.server_revision >= inboxRevisionRef.current && (await saveInboxState(nextInbox));
      if (accepted) {
        inboxRevisionRef.current = nextInbox.server_revision;
        setInboxSnapshot(projectInboxState(nextInbox, queuedInbox));
      }
      setInboxPendingCount(queuedInbox.length);
      await flushInboxPending(sourceApi);
    } catch (error) {
      handleError(error);
    }
  }

  async function flushInboxPending(sourceApi = apiRef.current) {
    const queued = await pendingInboxEvents();
    setInboxPendingCount(queued.length);
    if (queued.length === 0) {
      if ((await pendingEvents()).length + (await pendingActionEvents()).length === 0) setSyncStatus("synced");
      return;
    }

    setSyncStatus("pending_sync");
    await markInboxAttempt(queued);
    try {
      const meta = await ensureClientMeta();
      const response = await sourceApi.syncInboxEvents({
        deviceId: meta.deviceId,
        platform: meta.platform,
        events: queued,
        lastKnownServerTimeUtc: inbox.server_time_utc,
      });
      const ignoredIds = response.ignored_events.map((event) => event.event_id);
      await acknowledgeInboxEvents([...response.acknowledged_event_ids, ...ignoredIds]);
      await saveIgnoredEvents(response.ignored_events);
      const accepted =
        response.state.server_revision >= inboxRevisionRef.current && (await saveInboxState(response.state));
      const remaining = await pendingInboxEvents();
      const currentState = accepted ? response.state : (await loadInboxState()) ?? response.state;
      if (currentState.server_revision >= inboxRevisionRef.current) {
        inboxRevisionRef.current = currentState.server_revision;
        setInboxSnapshot(projectInboxState(currentState, remaining));
      }
      setInboxPendingCount(remaining.length);
      const [timerQueued, actionQueued] = await Promise.all([pendingEvents(), pendingActionEvents()]);
      setSyncStatus(remaining.length + timerQueued.length + actionQueued.length > 0 ? "pending_sync" : "synced");
    } catch (error) {
      await markInboxFailure(queued, error instanceof Error ? error.message : "sync_failed");
      handleError(error);
    }
  }

  async function onStart() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setTimerBusy(true);
    try {
      await enqueueTimerEvent({ type: "start", baseServerRevision: timer.server_revision });
      const queued = await pendingEvents();
      setTimerSnapshot(projectTimerState(timer, queued));
      setPendingCount(queued.length);
      setSyncStatus("pending_sync");
    } finally {
      setTimerBusy(false);
    }
    void flushPending().catch(handleError);
  }

  async function onStop() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setTimerBusy(true);
    try {
      await enqueueTimerEvent({
        type: "stop",
        baseServerRevision: timer.server_revision,
        metadata: { global_stop: true },
      });
      const queued = await pendingEvents();
      setTimerSnapshot(projectTimerState(timer, queued));
      setPendingCount(queued.length);
      setSyncStatus("pending_sync");
    } finally {
      setTimerBusy(false);
    }
    void flushPending().catch(handleError);
  }

  async function onEditFocusSession(sessionId: string, startedAtUtc: string, endedAtUtc: string) {
    await enqueueFocusSessionEdit({
      sessionId,
      startedAtUtc,
      endedAtUtc,
      baseServerRevision: timer.server_revision,
    });
    const queued = await pendingEvents();
    setHistory((current) => projectHistoryData(current, queued));
    setPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void flushPending().catch(handleError);
  }

  async function onDeleteFocusSession(sessionId: string) {
    await enqueueFocusSessionDelete({
      sessionId,
      baseServerRevision: timer.server_revision,
    });
    const queued = await pendingEvents();
    setHistory((current) => projectHistoryData(current, queued));
    setPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void flushPending().catch(handleError);
  }

  async function onStartActionFocus(activityId: string) {
    const activeActivityId = timer.active_activity_id ?? timer.active_interval?.activity_id ?? timer.active_session?.active_activity_id ?? null;
    if (activeActivityId === activityId) return;
    if (timer.active_session) {
      await enqueueSwitchActionFocus({ activityId, baseServerRevision: timer.server_revision });
    } else {
      await enqueueStartActionFocus({ activityId, baseServerRevision: timer.server_revision });
    }
    const queued = await pendingEvents();
    setTimerSnapshot(projectTimerState(timer, queued));
    setPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void flushPending().catch(handleError);
  }

  async function onSwitchActionFocus(activityId: string) {
    await enqueueSwitchActionFocus({ activityId, baseServerRevision: timer.server_revision });
    const queued = await pendingEvents();
    setTimerSnapshot(projectTimerState(timer, queued));
    setPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void flushPending().catch(handleError);
  }

  async function onStopActionFocus(activityId?: string | null) {
    await enqueueStopActionFocus({ activityId, baseServerRevision: timer.server_revision });
    const queued = await pendingEvents();
    setTimerSnapshot(projectTimerState(timer, queued));
    setPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void flushPending().catch(handleError);
  }

  async function onEditFocusInterval(intervalId: string, sessionId: string, startedAtUtc: string, endedAtUtc: string) {
    await enqueueFocusIntervalEdit({
      intervalId,
      sessionId,
      startedAtUtc,
      endedAtUtc,
      baseServerRevision: timer.server_revision,
    });
    const queued = await pendingEvents();
    setHistory((current) => projectHistoryData(current, queued));
    setPendingCount(queued.length);
    setSyncStatus("pending_sync");
    flushPendingSoon();
  }

  function resetUserSnapshots() {
    timerRevisionRef.current = 0;
    actionsRevisionRef.current = 0;
    inboxRevisionRef.current = 0;
    historyGoalRevisionRef.current = 0;
    setTimer(emptyTimerState());
    setActionsAndRef(emptyActionsState());
    setInbox(emptyInboxState());
    setHistory(emptyHistory());
    setGoal(emptyGoal());
    setPendingCount(0);
    setActionPendingCount(0);
    setInboxPendingCount(0);
  }

  async function onRequestOtp(email: string): Promise<OtpSendResult> {
    setBusy(true);
    try {
      return await api.requestOtp(email);
    } catch (error) {
      setSyncStatus("auth_required");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyOtp(email: string, otp: string) {
    setBusy(true);
    try {
      const result = await api.verifyOtp(email, otp);
      if (result.authenticated) {
        authDisplayNameRef.current = result.user?.name ?? "";
        await ensureClientUser(result.user?.id ?? null);
        resetUserSnapshots();
        setSyncStatus("connecting");
        await refreshAll();
      }
    } catch (error) {
      setSyncStatus("auth_required");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await api.logout();
    authDisplayNameRef.current = "";
    await ensureClientUser(null);
    resetUserSnapshots();
    setLocalSnapshotReady(true);
    setSyncStatus("auth_required");
  }

  async function refreshEngineOnce() {
    await Promise.all([refreshVersionOnce(), refreshOtaStateOnce()]);
  }

  function handleError(error: unknown) {
    if (error instanceof Error && error.name === "UnauthorizedError") {
      setSyncStatus("auth_required");
      return;
    }
    setSyncStatus(typeof navigator !== "undefined" && navigator.onLine ? "sync_failed" : "offline");
  }

  const publishAndroidActionsSnapshot = useCallback((nextActions: ActionsState): Promise<void> => {
    if (!localSnapshotReady || syncStatus === "auth_required") return Promise.resolve();
    // Native widget taps bump the stored version by +1; JS advances in wider steps to avoid equal-version drops.
    const snapshotVersion = Math.max(Date.now() * 1000, androidActionsSnapshotVersionRef.current + 1000);
    androidActionsSnapshotVersionRef.current = snapshotVersion;
    return saveAndroidActionsWidgetSnapshot(nextActions, {
      viewId: DEFAULT_ACTIONS_WIDGET_VIEW_ID,
      actions: nextActions.actions,
      snapshotVersion,
    });
  }, [localSnapshotReady, syncStatus]);

  const flushAndroidActionsSnapshotPublish = useCallback((nextActions?: ActionsState): void => {
    if (!localSnapshotReady || syncStatus === "auth_required") return;
    if (nextActions) androidActionsSnapshotLatestRef.current = nextActions;
    if (androidActionsSnapshotTimerRef.current != null) {
      window.clearTimeout(androidActionsSnapshotTimerRef.current);
      androidActionsSnapshotTimerRef.current = null;
    }
    const latest = androidActionsSnapshotLatestRef.current;
    if (latest) void publishAndroidActionsSnapshot(latest).catch(() => undefined);
  }, [localSnapshotReady, publishAndroidActionsSnapshot, syncStatus]);

  const requestAndroidActionsSnapshotPublish = useCallback((nextActions: ActionsState): void => {
    if (!localSnapshotReady || syncStatus === "auth_required") return;
    androidActionsSnapshotLatestRef.current = nextActions;
    if (androidActionsSnapshotTimerRef.current != null) return;
    androidActionsSnapshotTimerRef.current = window.setTimeout(() => {
      flushAndroidActionsSnapshotPublish();
    }, ANDROID_ACTIONS_WIDGET_SNAPSHOT_DEBOUNCE_MS);
  }, [flushAndroidActionsSnapshotPublish, localSnapshotReady, syncStatus]);

  useEffect(() => () => {
    if (androidActionsSnapshotTimerRef.current != null) window.clearTimeout(androidActionsSnapshotTimerRef.current);
  }, []);

  useEffect(() => {
    apiRef.current = api;
    refreshAllRef.current = refreshAll;
    refreshStateAndFlushRef.current = refreshStateAndFlush;
    applyServerStateRef.current = applyServerState;
    applyActivitiesStateRef.current = applyActivitiesState;
    applyInboxStateRef.current = applyInboxState;
    consumeAndroidActionsWidgetStatusChangesRef.current = consumeAndroidActionsWidgetStatusChanges;
  });

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      await ensureClientMeta();
      const resolvedApiBase = defaultApiBase();
      const bootApi = new BraiApi(resolvedApiBase);
      if (cancelled) return;
      setApiBase(resolvedApiBase);

      const session = await bootApi.session();
      if (cancelled) return;
      if (!session.authenticated) {
        authDisplayNameRef.current = "";
        resetUserSnapshots();
        setLocalSnapshotReady(true);
        setSyncStatus("auth_required");
        return;
      }

      authDisplayNameRef.current = session.user?.name ?? "";
      await ensureClientUser(session.user?.id ?? null);
      const [cachedState, cachedHistory, cachedGoal, cachedActions, cachedInbox, queued, queuedActions, queuedInbox] = await Promise.all([
        loadCanonicalState(),
        loadHistoryCache(),
        loadGoalCache(),
        loadActionsState(),
        loadInboxState(),
        pendingEvents(),
        pendingActionEvents(),
        pendingInboxEvents(),
      ]);

      if (cancelled) return;
      setPendingCount(queued.length);
      setActionPendingCount(queuedActions.length);
      setInboxPendingCount(queuedInbox.length);
      if (cachedState) {
        timerRevisionRef.current = cachedState.server_revision;
        setTimerSnapshot(projectTimerState(cachedState, queued));
      }
      if (cachedHistory.sessions.length > 0) setHistory(projectHistoryData(cachedHistory, queued));
      if (cachedGoal) setGoal(cachedGoal);
      if (cachedActions) actionsRevisionRef.current = cachedActions.server_revision;
      setActionsSnapshot(projectActionsState(cachedActions, queuedActions));
      if (cachedInbox) inboxRevisionRef.current = cachedInbox.server_revision;
      setInboxSnapshot(projectInboxState(cachedInbox, queuedInbox));
      setLocalSnapshotReady(true);
      await refreshAllRef.current(bootApi);
    }

    void boot().catch(handleError);
    return () => {
      cancelled = true;
    };
    // Boot is intentionally one-shot; rerunning on setter wrapper identity would duplicate startup sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useBraiLiveUpdates({
    api,
    syncStatus,
    setTimer,
    refreshStateAndFlushRef,
    applyServerStateRef,
    applyActivitiesStateRef,
    applyInboxStateRef,
  });

  useEffect(() => {
    if (!localSnapshotReady) return;
    if (syncStatus === "auth_required") {
      void clearAndroidActionsWidgetData();
      return;
    }
    requestAndroidActionsSnapshotPublish(actions);
  }, [actions, localSnapshotReady, requestAndroidActionsSnapshotPublish, syncStatus]);

  useEffect(() => {
    if (!localSnapshotReady || syncStatus === "auth_required") return undefined;
    const publishLatest = () => {
      const nextActions = actionsRef.current;
      flushAndroidActionsSnapshotPublish(nextActions);
    };
    const publishOnVisibilityChange = () => {
      publishLatest();
    };
    window.addEventListener("blur", publishLatest);
    window.addEventListener("focus", publishLatest);
    window.addEventListener("pagehide", publishLatest);
    window.addEventListener("pageshow", publishLatest);
    document.addEventListener("visibilitychange", publishOnVisibilityChange);
    return () => {
      window.removeEventListener("blur", publishLatest);
      window.removeEventListener("focus", publishLatest);
      window.removeEventListener("pagehide", publishLatest);
      window.removeEventListener("pageshow", publishLatest);
      document.removeEventListener("visibilitychange", publishOnVisibilityChange);
    };
  }, [flushAndroidActionsSnapshotPublish, localSnapshotReady, syncStatus]);

  useEffect(() => {
    if (
      !localSnapshotReady ||
      syncStatus === "auth_required" ||
      !isNativeShell() ||
      platformName() !== "android"
    ) return undefined;
    let cancelled = false;
    let listener: { remove: () => Promise<void> } | null = null;
    const consume = () => {
      if (!cancelled) void consumeAndroidActionsWidgetStatusChangesRef.current().catch(handleError);
    };
    consume();
    const interval = window.setInterval(consume, ANDROID_ACTIONS_WIDGET_STATUS_POLL_MS);
    void listenAndroidActionsWidgetStatusChangesPending(consume).then((handle) => {
      if (cancelled) {
        void handle?.remove().catch(() => undefined);
        return;
      }
      listener = handle;
    });
    window.addEventListener("focus", consume);
    window.addEventListener("pageshow", consume);
    document.addEventListener("visibilitychange", consume);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      void listener?.remove().catch(() => undefined);
      window.removeEventListener("focus", consume);
      window.removeEventListener("pageshow", consume);
      document.removeEventListener("visibilitychange", consume);
    };
  }, [localSnapshotReady, syncStatus]);

  const active = timer.active_session != null;
  const activeStartedAtUtc = timer.active_session?.started_at_utc ?? null;
  const totalPendingCount = pendingCount + actionPendingCount + inboxPendingCount;
  const displaySyncStatus =
    totalPendingCount > 0 && syncStatus === "synced" ? "pending_sync" : syncStatus;

  useEffect(() => {
    activeRef.current = active;
    stopTimerRef.current = onStop;
  });

  useEffect(() => {
    const previousHandler = window.BraiAndroidTimerStop;
    const handler = () => requestAndroidTimerStop();
    window.BraiAndroidTimerStop = handler;

    return () => {
      if (window.BraiAndroidTimerStop === handler) {
        window.BraiAndroidTimerStop = previousHandler;
      }
    };
  }, []);

  useEffect(() => {
    if (activeStartedAtUtc) {
      void startAndroidTimerNotification(activeStartedAtUtc);
      return;
    }
    void stopAndroidTimerNotification();
  }, [activeStartedAtUtc]);

  useEffect(() => {
    if (!activeStartedAtUtc) return;
    let cancelled = false;

    async function consumePendingStop() {
      if ((await consumeAndroidTimerStopRequest()) && !cancelled) {
        requestAndroidTimerStop();
      }
    }

    void consumePendingStop();
    return () => {
      cancelled = true;
    };
  }, [activeStartedAtUtc]);

  useEffect(() => {
    function onPopState() {
      setSection(sectionFromLocation());
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function selectSection(nextSection: SectionId) {
    setSection(nextSection);
    syncSectionUrl(nextSection);
    setMobileMenuOpen(false);
    setMobileContextPanelState(null);
  }

  function requestAndroidTimerStop(): boolean {
    if (!activeRef.current || androidStopInFlightRef.current) return false;
    androidStopInFlightRef.current = true;
    void stopTimerRef.current().finally(() => {
      androidStopInFlightRef.current = false;
    });
    return true;
  }

  function openSettingsPage() {
    selectSection("settings");
  }

  function toggleFocusContextPanel(panel: Exclude<FocusContextPanel, "none">) {
    if (isMobileNavigationViewport()) {
      const mobilePanel = panel === "goal" ? "focus-goal" : "focus-history";
      setMobileContextPanelClosing(false);
      setMobileContextPanel((current) => (current === mobilePanel ? null : mobilePanel));
      return;
    }

    const nextPanel = focusContextPanel === panel ? "none" : panel;
    setFocusContextPanel(nextPanel);
    saveFocusContextPanelPreference(nextPanel);
  }

  function toggleActionsInfoPanel() {
    setMobileContextPanelClosing(false);
    setMobileContextPanel((current) => (current === "actions-info" ? null : "actions-info"));
  }

  function toggleInboxInfoPanel() {
    setMobileContextPanelClosing(false);
    setMobileContextPanel((current) => (current === "inbox-info" ? null : "inbox-info"));
  }

  function setFocusBackground(nextBackground: FocusBackgroundMode) {
    setFocusBackgroundState(nextBackground);
    saveFocusBackgroundPreference(nextBackground);
  }

  const swipeNavigation = useSectionSwipeNavigation(
    section,
    selectSection,
    syncStatus !== "auth_required" &&
      !mobileMenuOpen &&
      !mobileContextPanel &&
      !actionOverlayOpen &&
      section !== "archive" &&
      section !== "settings" &&
      section !== "engine" &&
      section !== "evil-eye",
  );

  function setMobileContextPanelState(panel: MobileContextPanel | null) {
    setMobileContextPanelClosing(false);
    setMobileContextPanel(panel);
  }

  function markMobileContextPanelClosing() {
    setMobileContextPanelClosing(true);
  }

  const mobileContextPanelActive = !mobileContextPanelClosing;
  const actionsInfoActive = mobileContextPanelActive && mobileContextPanel === "actions-info";
  const inboxInfoActive = mobileContextPanelActive && mobileContextPanel === "inbox-info";
  const focusGoalActive = mobileViewport ? mobileContextPanelActive && mobileContextPanel === "focus-goal" : focusContextPanel === "goal";
  const focusHistoryActive = mobileViewport ? mobileContextPanelActive && mobileContextPanel === "focus-history" : focusContextPanel === "history";
  const actionCommands = createBraiActionCommands({
    actions,
    flushActionPending,
    getActions: () => actionsRef.current,
    publishActionsSnapshot: async (nextActions) => requestAndroidActionsSnapshotPublish(nextActions),
    setActionPendingCount,
    setActions: setActionsAndRef,
    setSyncStatus,
  });
  const inboxCommands = createBraiInboxCommands({
    flushInboxPending,
    inbox,
    setInbox,
    setInboxPendingCount,
    setSyncStatus,
  });

  return { actionOverlayOpen, actions, actionsInfoActive, active, appSettings, authDisplayName: authDisplayNameRef.current, bundlePublishedAt, busy, displaySyncStatus, focusBackground, focusContextPanel, focusGoalActive, focusHistoryActive, goal, history, inbox, inboxInfoActive, localSnapshotReady, markMobileContextPanelClosing, mobileContextPanel, mobileMenuOpen, ...actionCommands, ...inboxCommands, onDeleteFocusSession, onEditFocusInterval, onEditFocusSession, onLogout, onRequestOtp, onStart, onStartActionFocus, onStop, onStopActionFocus, onSwitchActionFocus, onUpdateAppSettings: updateAppSettings, onVerifyOtp, openSettingsPage, otaCheckedAt, otaRefreshing, otaState, refreshEngineOnce, refreshOtaStateOnce, section, selectSection, setActionOverlayOpen, setFocusBackground, setMobileContextPanel: setMobileContextPanelState, setMobileMenuOpen, setTheme, swipeNavigation, theme, timer, timerBusy, todayKey, toggleActionsInfoPanel, toggleFocusContextPanel, toggleInboxInfoPanel, totalPendingCount, versionCheckedAt, versionError, versionRefreshing, versionState };
}

function loadAppSettingsPreference(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_APP_SETTINGS;
  try {
    const parsed = JSON.parse(getBraiLocalStorageItem(APP_SETTINGS_STORAGE_KEY) ?? "null") as Partial<AppSettings> | null;
    const settings = { ...DEFAULT_APP_SETTINGS, ...(parsed ?? {}) };
    setDisplayTimeZone(settings.display_timezone);
    return settings;
  } catch {
    setDisplayTimeZone(DEFAULT_APP_SETTINGS.display_timezone);
    return DEFAULT_APP_SETTINGS;
  }
}

function saveAppSettingsPreference(settings: AppSettings) {
  if (typeof window === "undefined") return;
  setBraiLocalStorageItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function loadFocusContextPanelPreference(): FocusContextPanel {
  if (typeof window === "undefined") return "none";
  const value = getBraiLocalStorageItem(FOCUS_CONTEXT_PANEL_STORAGE_KEY);
  return value === "goal" || value === "history" || value === "none" ? value : "none";
}

function saveFocusContextPanelPreference(panel: FocusContextPanel) {
  if (typeof window === "undefined") return;
  setBraiLocalStorageItem(FOCUS_CONTEXT_PANEL_STORAGE_KEY, panel);
}

function loadFocusBackgroundPreference(): FocusBackgroundMode {
  if (typeof window === "undefined") return "galaxy";
  const value = getBraiLocalStorageItem(FOCUS_BACKGROUND_STORAGE_KEY);
  return value === "evil-eye" ? value : "galaxy";
}

function saveFocusBackgroundPreference(background: FocusBackgroundMode) {
  if (typeof window === "undefined") return;
  setBraiLocalStorageItem(FOCUS_BACKGROUND_STORAGE_KEY, background);
}
