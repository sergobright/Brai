"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BrightOsApi } from "@/shared/api/brightOsApi";
import { defaultApiBase } from "@/shared/config/runtime";
import { consumeAndroidTimerStopRequest, startAndroidTimerNotification, stopAndroidTimerNotification } from "@/shared/platform/androidTimerNotification";
import { acknowledgeActionEvents, loadActionsState, markActionAttempt, markActionFailure, pendingActionEvents, projectActionsState, saveActionsState } from "@/shared/storage/activityStore";
import { ensureClientMeta } from "@/shared/storage/db";
import { acknowledgeInboxEvents, loadInboxState, markInboxAttempt, markInboxFailure, pendingInboxEvents, projectInboxState, saveInboxState } from "@/shared/storage/inboxStore";
import { projectHistoryData, projectTimerState } from "@/shared/storage/projection";
import { acknowledgeEvents, enqueueFocusIntervalEdit, enqueueFocusSessionDelete, enqueueFocusSessionEdit, enqueueStartActionFocus, enqueueStopActionFocus, enqueueSwitchActionFocus, enqueueTimerEvent, loadCanonicalState, loadGoalCache, loadHistoryCache, markAttempt, markFailure, pendingEvents, saveCanonicalState, saveGoalCache, saveHistoryCache, saveIgnoredEvents } from "@/shared/storage/syncStore";
import { tickTimerState } from "@/shared/time/format";
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
import { createBrightOsActionCommands } from "./useBrightOsActionCommands";
import { createBrightOsInboxCommands } from "./useBrightOsInboxCommands";
import { useBrightOsLiveUpdates } from "./useBrightOsLiveUpdates";
import { useBrightOsOta } from "./useBrightOsOta";
import { useBrightOsTheme } from "./useBrightOsTheme";
import { useBrightOsVersion } from "./useBrightOsVersion";

/**
 * Owns the Bright OS client state machine, local cache loading, and sync flow.
 */
export function useBrightOsAppState(initialSection: SectionId) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const { setTheme, theme } = useBrightOsTheme();
  const { bundlePublishedAt, otaCheckedAt, otaRefreshing, otaState, refreshOtaStateOnce } =
    useBrightOsOta();
  const [todayKey] = useState(() => moscowTodayKey());
  const [apiBase, setApiBase] = useState(defaultApiBase());
  const api = useMemo(() => new BrightOsApi(apiBase), [apiBase]);
  const { refreshVersionOnce, versionCheckedAt, versionError, versionRefreshing, versionState } = useBrightOsVersion(api);
  const apiRef = useRef(api);
  const refreshAllRef = useRef<(sourceApi?: BrightOsApi) => Promise<void>>(async () => undefined);
  const refreshStateAndFlushRef = useRef<() => Promise<void>>(async () => undefined);
  const applyServerStateRef = useRef<(state: TimerState) => Promise<void>>(async () => undefined);
  const applyActivitiesStateRef = useRef<(state: ActionsState) => Promise<void>>(async () => undefined);
  const applyInboxStateRef = useRef<(state: InboxState) => Promise<void>>(async () => undefined);
  const timerRevisionRef = useRef(0);
  const actionsRevisionRef = useRef(0);
  const inboxRevisionRef = useRef(0);
  const historyGoalRevisionRef = useRef(0);
  const activeRef = useRef(false);
  const androidStopInFlightRef = useRef(false);
  const timerFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimerRef = useRef<() => Promise<void>>(async () => undefined);
  const [timer, setTimer] = useState<TimerState>(() => emptyTimerState());
  const [actions, setActions] = useState<ActionsState>(() => emptyActionsState());
  const [inbox, setInbox] = useState<InboxState>(() => emptyInboxState());
  const [history, setHistory] = useState<HistoryData>(() => emptyHistory());
  const [goal, setGoal] = useState<GoalData>(() => emptyGoal());
  const [localSnapshotReady, setLocalSnapshotReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [pendingCount, setPendingCount] = useState(0);
  const [actionPendingCount, setActionPendingCount] = useState(0);
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [timerBusy, setTimerBusy] = useState(false);
  const [actionOverlayOpen, setActionOverlayOpen] = useState(false);
  const [focusContextPanel, setFocusContextPanel] = useState<FocusContextPanel>(loadFocusContextPanelPreference);
  const [focusBackground, setFocusBackgroundState] = useState<FocusBackgroundMode>(loadFocusBackgroundPreference);
  const [mobileContextPanel, setMobileContextPanel] = useState<MobileContextPanel | null>(null);
  const [mobileContextPanelClosing, setMobileContextPanelClosing] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileViewport = useMobileNavigationViewport();

  function setTimerSnapshot(nextState: TimerState) {
    setTimer((current) => (current.server_revision > nextState.server_revision ? current : nextState));
  }

  function setActionsSnapshot(nextState: ActionsState) {
    setActions((current) => (current.server_revision > nextState.server_revision ? current : nextState));
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
    setActionsSnapshot(projectActionsState(state, []));
    setActionPendingCount(0);
    setSyncStatus("synced");
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
      const [nextState, nextHistory, nextGoal, nextActions, nextInbox] = await Promise.all([
        sourceApi.state(),
        sourceApi.history(),
        sourceApi.goal(),
        sourceApi.actions(),
        sourceApi.inbox(),
      ]);
      const [queued, queuedActions, queuedInbox] = await Promise.all([pendingEvents(), pendingActionEvents(), pendingInboxEvents()]);
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
        setActionsSnapshot(projectActionsState(nextActions, queuedActions));
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

  async function refreshActionsAndFlush(sourceApi = apiRef.current) {
    try {
      const nextActions = await sourceApi.actions();
      const queuedActions = await pendingActionEvents();
      const accepted =
        nextActions.server_revision >= actionsRevisionRef.current && (await saveActionsState(nextActions));
      if (accepted) {
        actionsRevisionRef.current = nextActions.server_revision;
        setActionsSnapshot(projectActionsState(nextActions, queuedActions));
      }
      setActionPendingCount(queuedActions.length);
      await flushActionPending(sourceApi);
    } catch (error) {
      handleError(error);
    }
  }

  async function flushActionPending(sourceApi = apiRef.current) {
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
        lastKnownServerTimeUtc: actions.server_time_utc,
      });
      const ignoredIds = response.ignored_events.map((event) => event.event_id);
      await acknowledgeActionEvents([...response.acknowledged_event_ids, ...ignoredIds]);
      await saveIgnoredEvents(response.ignored_events);
      const accepted =
        response.state.server_revision >= actionsRevisionRef.current && (await saveActionsState(response.state));
      const remaining = await pendingActionEvents();
      const currentState = accepted ? response.state : (await loadActionsState()) ?? response.state;
      if (currentState.server_revision >= actionsRevisionRef.current) {
        actionsRevisionRef.current = currentState.server_revision;
        setActionsSnapshot(projectActionsState(currentState, remaining));
      }
      setActionPendingCount(remaining.length);
      const [timerQueued, inboxQueued] = await Promise.all([pendingEvents(), pendingInboxEvents()]);
      setSyncStatus(remaining.length + timerQueued.length + inboxQueued.length > 0 ? "pending_sync" : "synced");
    } catch (error) {
      await markActionFailure(queued, error instanceof Error ? error.message : "sync_failed");
      handleError(error);
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

  async function onLogin(password: string) {
    setBusy(true);
    try {
      const result = await api.login(password);
      if (result.authenticated) {
        setSyncStatus("connecting");
        await refreshAll();
      }
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await api.logout();
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

  useEffect(() => {
    apiRef.current = api;
    refreshAllRef.current = refreshAll;
    refreshStateAndFlushRef.current = refreshStateAndFlush;
    applyServerStateRef.current = applyServerState;
    applyActivitiesStateRef.current = applyActivitiesState;
    applyInboxStateRef.current = applyInboxState;
  });

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      await ensureClientMeta();
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
      const resolvedApiBase = defaultApiBase();

      if (cancelled) return;
      setApiBase(resolvedApiBase);
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
      await refreshAllRef.current(new BrightOsApi(resolvedApiBase));
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useBrightOsLiveUpdates({
    api,
    syncStatus,
    setTimer,
    refreshStateAndFlushRef,
    applyServerStateRef,
    applyActivitiesStateRef,
    applyInboxStateRef,
  });

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
    const previousHandler = window.BrightOsAndroidTimerStop;
    const handler = () => requestAndroidTimerStop();
    window.BrightOsAndroidTimerStop = handler;

    return () => {
      if (window.BrightOsAndroidTimerStop === handler) {
        window.BrightOsAndroidTimerStop = previousHandler;
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
  const actionCommands = createBrightOsActionCommands({
    actions,
    flushActionPending,
    setActionPendingCount,
    setActions,
    setSyncStatus,
  });
  const inboxCommands = createBrightOsInboxCommands({
    flushInboxPending,
    inbox,
    setInbox,
    setInboxPendingCount,
    setSyncStatus,
  });

  return { actionOverlayOpen, actions, actionsInfoActive, active, bundlePublishedAt, busy, displaySyncStatus, focusBackground, focusContextPanel, focusGoalActive, focusHistoryActive, goal, history, inbox, inboxInfoActive, localSnapshotReady, markMobileContextPanelClosing, mobileContextPanel, mobileMenuOpen, ...actionCommands, ...inboxCommands, onDeleteFocusSession, onEditFocusInterval, onEditFocusSession, onLogin, onLogout, onStart, onStartActionFocus, onStop, onStopActionFocus, onSwitchActionFocus, openSettingsPage, otaCheckedAt, otaRefreshing, otaState, refreshEngineOnce, refreshOtaStateOnce, section, selectSection, setActionOverlayOpen, setFocusBackground, setMobileContextPanel: setMobileContextPanelState, setMobileMenuOpen, setTheme, swipeNavigation, theme, timer, timerBusy, todayKey, toggleActionsInfoPanel, toggleFocusContextPanel, toggleInboxInfoPanel, totalPendingCount, versionCheckedAt, versionError, versionRefreshing, versionState };
}

function loadFocusContextPanelPreference(): FocusContextPanel {
  if (typeof window === "undefined") return "none";
  const value = window.localStorage.getItem(FOCUS_CONTEXT_PANEL_STORAGE_KEY);
  return value === "goal" || value === "history" || value === "none" ? value : "none";
}

function saveFocusContextPanelPreference(panel: FocusContextPanel) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FOCUS_CONTEXT_PANEL_STORAGE_KEY, panel);
}

function loadFocusBackgroundPreference(): FocusBackgroundMode {
  if (typeof window === "undefined") return "galaxy";
  const value = window.localStorage.getItem(FOCUS_BACKGROUND_STORAGE_KEY);
  return value === "evil-eye" ? value : "galaxy";
}

function saveFocusBackgroundPreference(background: FocusBackgroundMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FOCUS_BACKGROUND_STORAGE_KEY, background);
}
