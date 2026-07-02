import type {
  GoalData,
  HistoryData,
  PendingTimerEvent,
  TimerState,
  TimerSyncResponse,
} from "@/shared/types/timer";
import type { ActivitiesState, ActivitiesSyncResponse, PendingActivityEvent } from "@/shared/types/activities";
import type { InboxState, InboxSyncResponse, PendingInboxEvent } from "@/shared/types/inbox";

interface RequestOptions extends RequestInit {
  json?: unknown;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Wraps the Brai HTTP API with typed client methods.
 */
export class BraiApi {
  constructor(private readonly baseUrl: string) {}

  async session(): Promise<{ authenticated: boolean }> {
    return this.request("/auth/session");
  }

  async login(password: string): Promise<{ authenticated: boolean }> {
    return this.request("/auth/login", {
      method: "POST",
      json: { password },
    });
  }

  async logout(): Promise<void> {
    await this.request("/auth/logout", { method: "POST" });
  }

  async state(): Promise<TimerState> {
    return this.request("/v1/timer/state");
  }

  async history(): Promise<HistoryData> {
    return this.request("/v1/sessions");
  }

  async goal(): Promise<GoalData> {
    return this.request("/v1/goals/challenge");
  }

  async activities(): Promise<ActivitiesState> {
    return fromActivitiesState(await this.request<ActivitiesApiState>("/v1/activities"));
  }

  async actions(): Promise<ActivitiesState> {
    return this.activities();
  }

  async inbox(): Promise<InboxState> {
    return this.request("/v1/inbox");
  }

  async version(): Promise<AppVersionState> {
    return this.request("/v1/version");
  }

  async syncEvents(params: {
    deviceId: string;
    platform: string;
    events: PendingTimerEvent[];
    lastKnownServerTimeUtc?: string | null;
  }): Promise<TimerSyncResponse> {
    return this.request("/v1/timer/events/sync", {
      method: "POST",
      json: {
        device: {
          device_id: params.deviceId,
          platform: params.platform,
          display_name: params.platform === "android" ? "Brai Android" : "Brai Web",
        },
        last_known_server_time_utc: params.lastKnownServerTimeUtc ?? null,
        events: params.events.map((event) => ({
          event_id: event.eventId,
          client_sequence: event.clientSequence,
          type: event.type,
          occurred_at_utc: event.occurredAtUtc,
          local_timer_id: event.localTimerId,
          base_server_revision: event.baseServerRevision,
          payload_version: event.payloadVersion,
          metadata: event.metadata,
        })),
      },
    });
  }

  async syncActivityEvents(params: {
    deviceId: string;
    platform: string;
    events: PendingActivityEvent[];
    lastKnownServerTimeUtc?: string | null;
  }): Promise<ActivitiesSyncResponse> {
    const response = await this.request<ActivitiesApiSyncResponse>("/v1/activities/events/sync", {
      method: "POST",
      json: {
        device: {
          device_id: params.deviceId,
          platform: params.platform,
          display_name: params.platform === "android" ? "Brai Android" : "Brai Web",
        },
        last_known_server_time_utc: params.lastKnownServerTimeUtc ?? null,
        events: params.events.map((event) => ({
          event_id: event.eventId,
          client_sequence: event.clientSequence,
          change_type: event.type,
          occurred_at_utc: event.occurredAtUtc,
          activity_id: event.actionId,
          base_server_revision: event.baseServerRevision,
          payload_version: event.payloadVersion,
          payload: event.payload,
        })),
      },
    });
    return { ...response, state: fromActivitiesState(response.state) };
  }

  async syncActionEvents(params: {
    deviceId: string;
    platform: string;
    events: PendingActivityEvent[];
    lastKnownServerTimeUtc?: string | null;
  }): Promise<ActivitiesSyncResponse> {
    return this.syncActivityEvents(params);
  }

  async syncInboxEvents(params: {
    deviceId: string;
    platform: string;
    events: PendingInboxEvent[];
    lastKnownServerTimeUtc?: string | null;
  }): Promise<InboxSyncResponse> {
    return this.request("/v1/inbox/events/sync", {
      method: "POST",
      json: {
        device: {
          device_id: params.deviceId,
          platform: params.platform,
          display_name: params.platform === "android" ? "Brai Android" : "Brai Web",
        },
        last_known_server_time_utc: params.lastKnownServerTimeUtc ?? null,
        events: params.events.map((event) => ({
          event_id: event.eventId,
          client_sequence: event.clientSequence,
          type: event.type,
          occurred_at_utc: event.occurredAtUtc,
          inbox_id: event.inboxId,
          base_server_revision: event.baseServerRevision,
          payload_version: event.payloadVersion,
          payload: event.payload,
        })),
      },
    });
  }

  liveUrl(): string {
    const target = new URL(resolvePath(this.baseUrl, "/v1/live"), window.location.href);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    return target.toString();
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.json !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    if (options.signal?.aborted) abortRequest();
    options.signal?.addEventListener("abort", abortRequest, { once: true });
    const timeoutId = setTimeout(abortRequest, REQUEST_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(resolvePath(this.baseUrl, path), {
        ...options,
        headers,
        credentials: "include",
        signal: controller.signal,
        body: options.json === undefined ? options.body : JSON.stringify(options.json),
      });
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortRequest);
    }

    if (!response.ok) {
      const error = new Error(`brai_api_${response.status}`);
      error.name = response.status === 401 ? "UnauthorizedError" : "BraiApiError";
      throw error;
    }

    return (await response.json()) as T;
  }
}

interface ActivitiesApiState {
  server_time_utc: string;
  server_revision: number;
  activities: ActivitiesState["actions"];
  archived_activities?: ActivitiesState["archived_actions"];
}

interface ActivitiesApiSyncResponse {
  acknowledged_event_ids: string[];
  ignored_events: Array<{ event_id: string; reason: string }>;
  server_revision: number;
  server_time_utc: string;
  state: ActivitiesApiState;
}

export type VersionTypeId = "canon" | "release" | "build" | "apk";

export type AppVersionLedgerRow = {
  id: number;
  version_type_id: VersionTypeId;
  version: number;
  included_in_version_id: number | null;
  short_changes: string;
  detailed_changes: string;
  reason: string;
  released_at_utc: string;
  created_at_utc: string;
};

export type AppVersionState = {
  server_time_utc: string;
  version: string;
  parts: Record<VersionTypeId, number>;
  latest: Record<VersionTypeId, AppVersionLedgerRow | null>;
  apk_release: {
    file: string;
    version: string | null;
    version_code: number;
    published_at: string | null;
  } | null;
};

function fromActivitiesState(state: ActivitiesApiState): ActivitiesState {
  return {
    server_time_utc: state.server_time_utc,
    server_revision: state.server_revision,
    actions: state.activities,
    archived_actions: state.archived_activities ?? [],
  };
}

function resolvePath(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (!baseUrl || baseUrl === "/") return cleanPath;
  return `${baseUrl.replace(/\/$/, "")}${cleanPath}`;
}
