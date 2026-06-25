"use client";

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { BrightOsApi } from "@/shared/api/brightOsApi";
import { tickTimerState } from "@/shared/time/format";
import type { ActionsState } from "@/shared/types/activities";
import type { SyncStatus, TimerState } from "@/shared/types/timer";

type LiveUpdateOptions = {
  api: BrightOsApi;
  syncStatus: SyncStatus;
  setTimer: Dispatch<SetStateAction<TimerState>>;
  refreshStateAndFlushRef: MutableRefObject<() => Promise<void>>;
  applyServerStateRef: MutableRefObject<(state: TimerState) => Promise<void>>;
  applyActionsStateRef: MutableRefObject<(state: ActionsState) => Promise<void>>;
};

/**
 * Keeps timer display time and websocket-delivered server state fresh.
 */
export function useBrightOsLiveUpdates({
  api,
  syncStatus,
  setTimer,
  refreshStateAndFlushRef,
  applyServerStateRef,
  applyActionsStateRef,
}: LiveUpdateOptions) {
  useEffect(() => {
    const interval = window.setInterval(() => {
      setTimer((current) => tickTimerState(current));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [setTimer]);

  useEffect(() => {
    const interval = window.setInterval(() => void refreshStateAndFlushRef.current(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshStateAndFlushRef]);

  useEffect(() => {
    const refresh = () => void refreshStateAndFlushRef.current();
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
    if (syncStatus === "auth_required") return;
    let connected = true;
    let websocket: WebSocket | null = null;
    try {
      websocket = new WebSocket(api.liveUrl());
      websocket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as {
          state?: TimerState;
          activities_state?: {
            server_time_utc: string;
            server_revision: number;
            activities: ActionsState["actions"];
            archived_activities?: ActionsState["archived_actions"];
          };
        };
        if (payload.state) void applyServerStateRef.current(payload.state);
        if (payload.activities_state) {
          void applyActionsStateRef.current({
            server_time_utc: payload.activities_state.server_time_utc,
            server_revision: payload.activities_state.server_revision,
            actions: payload.activities_state.activities,
            archived_actions: payload.activities_state.archived_activities ?? [],
          });
        }
      };
      websocket.onerror = () => websocket?.close();
      websocket.onclose = () => {
        if (connected) void refreshStateAndFlushRef.current();
      };
    } catch {
      return;
    }

    return () => {
      connected = false;
      websocket?.close();
    };
  }, [api, syncStatus, refreshStateAndFlushRef, applyServerStateRef, applyActionsStateRef]);
}
