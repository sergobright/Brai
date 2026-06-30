export type TimerEventType =
  | "start"
  | "stop"
  | "edit_session"
  | "delete_session"
  | "start_activity_focus"
  | "switch_activity_focus"
  | "stop_activity_focus"
  | "edit_focus_interval";

export type SyncStatus =
  | "connecting"
  | "synced"
  | "pending_sync"
  | "offline"
  | "auth_required"
  | "sync_failed";

export interface FocusSessionInterval {
  id: string;
  focus_session_id: string;
  activity_id: string | null;
  activity_title: string | null;
  started_at_utc: string;
  ended_at_utc: string | null;
  duration_seconds: number | null;
  started_date_msk?: string;
  started_hour_msk?: number;
  ended_date_msk?: string | null;
  ended_hour_msk?: number | null;
  pending?: boolean;
}

export interface TimerSession {
  id: string;
  started_at_utc: string;
  ended_at_utc: string | null;
  duration_seconds: number | null;
  intervals?: FocusSessionInterval[];
  activity_interval_count?: number;
  primary_activity_id?: string | null;
  primary_activity_title?: string | null;
  active_interval?: FocusSessionInterval | null;
  active_activity_id?: string | null;
  start_origin?: "focus" | "activity";
  started_by_activity_id?: string | null;
  source_session_id?: string;
  started_date_msk?: string;
  started_hour_msk?: number;
  ended_date_msk?: string | null;
  ended_hour_msk?: number | null;
  pending?: boolean;
}

export interface TimerState {
  server_time_utc: string;
  server_revision: number;
  timezone: "Europe/Moscow";
  active_session: TimerSession | null;
  elapsed_seconds: number;
  active_interval?: FocusSessionInterval | null;
  active_interval_elapsed_seconds?: number;
  active_activity_id?: string | null;
  active_session_start_origin?: "focus" | "activity" | null;
  active_session_started_by_activity_id?: string | null;
}

export interface PendingTimerEvent {
  eventId: string;
  deviceId: string;
  clientSequence: number;
  type: TimerEventType;
  occurredAtUtc: string;
  localTimerId: string;
  baseServerRevision: number;
  payloadVersion: 1;
  metadata?: Record<string, unknown>;
  status: "pending" | "syncing" | "failed";
  attemptCount: number;
  lastError?: string | null;
  enqueuedAtUtc: string;
  lastSyncAttemptAtUtc?: string | null;
}

export interface TimerSyncEnvelope {
  schemaVersion: number;
  deviceId: string;
  platform: string;
  nextClientSequence: number;
  lastServerRevision: number;
  pendingEvents: PendingTimerEvent[];
  canonicalState: TimerState | null;
}

export interface TimerSyncResponse {
  acknowledged_event_ids: string[];
  ignored_events: Array<{ event_id: string; reason: string }>;
  server_revision: number;
  state: TimerState;
}

export interface HistoryDateGroup {
  total_seconds: number;
  hours?: Record<string, { total_seconds: number; sessions: TimerSession[] }>;
  sessions?: TimerSession[];
}

export interface HistoryData {
  sessions: TimerSession[];
  groups: Record<string, HistoryDateGroup>;
}

export interface GoalDay {
  date: string;
  completed_seconds: number;
  completed_hours: number;
  percentage: number;
  achieved: boolean;
}

export interface GoalData {
  timezone: "Europe/Moscow";
  start_date: string;
  end_date: string;
  days_count: number;
  daily_goal_seconds: number;
  total_goal_seconds: number;
  completed_seconds: number;
  completed_hours: number;
  percentage: number;
  remaining_seconds: number;
  remaining_days: number;
  required_average_seconds_per_remaining_day: number;
  required_average_hours_per_remaining_day: number;
  achieved: boolean;
  days: GoalDay[];
}

export function emptyTimerState(now = new Date()): TimerState {
  return {
    server_time_utc: now.toISOString(),
    server_revision: 0,
    timezone: "Europe/Moscow",
    active_session: null,
    elapsed_seconds: 0,
    active_interval: null,
    active_interval_elapsed_seconds: 0,
    active_activity_id: null,
    active_session_start_origin: null,
    active_session_started_by_activity_id: null,
  };
}

export function emptyHistory(): HistoryData {
  return { sessions: [], groups: {} };
}

/**
 * Builds the empty default challenge goal used before the first server snapshot.
 */
export function emptyGoal(): GoalData {
  const start = "2026-06-12";
  const days = Array.from({ length: 28 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 5, 12 + index))
      .toISOString()
      .slice(0, 10);
    return {
      date,
      completed_seconds: 0,
      completed_hours: 0,
      percentage: 0,
      achieved: false,
    };
  });

  return {
    timezone: "Europe/Moscow",
    start_date: start,
    end_date: "2026-07-09",
    days_count: 28,
    daily_goal_seconds: 43200,
    total_goal_seconds: 1209600,
    completed_seconds: 0,
    completed_hours: 0,
    percentage: 0,
    remaining_seconds: 1209600,
    remaining_days: 28,
    required_average_seconds_per_remaining_day: 43200,
    required_average_hours_per_remaining_day: 12,
    achieved: false,
    days,
  };
}
