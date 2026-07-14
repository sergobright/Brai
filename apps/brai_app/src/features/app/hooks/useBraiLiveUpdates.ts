"use client";

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { BraiApi } from "@/shared/api/braiApi";
import { tickTimerState } from "@/shared/time/format";
import type { ActionsState } from "@/shared/types/activities";
import type { ClientOwnerScope } from "@/shared/storage/db";
import type { InboxState } from "@/shared/types/inbox";
import type { SyncStatus, TimerState } from "@/shared/types/timer";

type LiveUpdateOptions = {
  api: BraiApi;
  ownerScope: ClientOwnerScope | null;
  ownerEpochRef: MutableRefObject<number>;
  syncStatus: SyncStatus;
  setTimer: Dispatch<SetStateAction<TimerState>>;
  refreshStateAndFlushRef: MutableRefObject<(scope?: ClientOwnerScope) => Promise<void>>;
  applyServerStateRef: MutableRefObject<(state: TimerState, scope?: ClientOwnerScope) => Promise<void>>;
  applyActivitiesStateRef: MutableRefObject<(state: ActionsState, scope?: ClientOwnerScope) => Promise<void>>;
  applyInboxStateRef: MutableRefObject<(state: InboxState, scope?: ClientOwnerScope) => Promise<void>>;
};

/**
 * Keeps timer display time and websocket-delivered server state fresh.
 */
export function useBraiLiveUpdates({
  api,
  ownerScope,
  ownerEpochRef,
  syncStatus,
  setTimer,
  refreshStateAndFlushRef,
  applyServerStateRef,
  applyActivitiesStateRef,
  applyInboxStateRef,
}: LiveUpdateOptions) {
  useEffect(() => {
    const interval = window.setInterval(() => {
      setTimer((current) => tickTimerState(current));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [setTimer]);

  useEffect(() => {
    const interval = window.setInterval(() => void refreshStateAndFlushRef.current().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [refreshStateAndFlushRef]);

  useEffect(() => {
    const refresh = () => void refreshStateAndFlushRef.current().catch(() => undefined);
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };

    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshStateAndFlushRef]);

  useEffect(() => {
    if (syncStatus === "auth_required" || !ownerScope) return;
    let connected = true;
    let websocket: WebSocket | null = null;
    try {
      websocket = new WebSocket(api.liveUrl());
      websocket.onmessage = (event) => {
        if (!connected || ownerEpochRef.current !== ownerScope.epoch) return;
        const payload = JSON.parse(String(event.data)) as {
          state?: TimerState;
          activities_state?: {
            server_time_utc: string;
            server_revision: number;
            activities: ActionsState["actions"];
            archived_activities?: ActionsState["archived_actions"];
            legacy_operations?: NonNullable<ActionsState["legacy_operations"]>;
            goals?: NonNullable<ActionsState["goals"]>;
            archived_goals?: NonNullable<ActionsState["archived_goals"]>;
          };
          inbox_state?: InboxState;
          relations_state?: { server_revision?: number };
          context_decisions_state?: { server_revision?: number };
        };
        if (payload.state) void applyServerStateRef.current(payload.state, ownerScope).catch(() => undefined);
        if (payload.activities_state) {
          void applyActivitiesStateRef.current({
            server_time_utc: payload.activities_state.server_time_utc,
            server_revision: payload.activities_state.server_revision,
            actions: payload.activities_state.activities,
            archived_actions: payload.activities_state.archived_activities ?? [],
            legacy_operations: payload.activities_state.legacy_operations ?? [],
            goals: payload.activities_state.goals ?? [],
            archived_goals: payload.activities_state.archived_goals ?? [],
          }, ownerScope).catch(() => undefined);
        }
        if (payload.inbox_state) void applyInboxStateRef.current(payload.inbox_state, ownerScope).catch(() => undefined);
        if (payload.relations_state || payload.context_decisions_state) void refreshStateAndFlushRef.current(ownerScope).catch(() => undefined);
      };
      websocket.onerror = () => websocket?.close();
      websocket.onclose = () => {
        if (connected && ownerEpochRef.current === ownerScope.epoch) void refreshStateAndFlushRef.current(ownerScope).catch(() => undefined);
      };
    } catch {
      return;
    }

    return () => {
      connected = false;
      websocket?.close();
    };
  }, [api, ownerEpochRef, ownerScope, syncStatus, refreshStateAndFlushRef, applyServerStateRef, applyActivitiesStateRef, applyInboxStateRef]);
}
