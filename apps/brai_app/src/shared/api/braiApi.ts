import type {
  GoalData,
  HistoryData,
  PendingTimerEvent,
  TimerState,
  TimerSyncResponse,
} from "@/shared/types/timer";
import type { ActivitiesState, ActivitiesSyncResponse, PendingActivityEvent } from "@/shared/types/activities";
import type { InboxState, InboxSyncResponse, InboxWorkflowDetails, PendingInboxEvent } from "@/shared/types/inbox";

interface RequestOptions extends RequestInit {
  json?: unknown;
}

const REQUEST_TIMEOUT_MS = 8_000;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthSession = {
  authenticated: boolean;
  user?: AuthUser | null;
};

export type OtpSendResult = {
  sent?: boolean;
  success?: boolean;
  expires_in_seconds?: number;
  resend_after_seconds?: number;
  resend_strategy?: "rotate" | "reuse";
};

export type AuthOnboardingContext = {
  name?: string;
  preliminaryUserId?: string;
  duplicatePreliminaryUserId?: string;
  preliminaryClaimToken?: string;
  deviceFingerprint?: string;
};

export type AiLogIoRow = {
  ref: string;
  value: unknown;
};

export type AiLogJsonData = {
  inputs?: AiLogIoRow[];
  outputs?: AiLogIoRow[];
  usage?: { model?: string; prompt_tokens?: number; completion_tokens?: number };
  timings_ms?: { total?: number; model?: number; postprocess?: number };
  metadata?: Record<string, unknown>;
  error_code?: string;
};

export type AiLog = {
  id: number;
  agent_id: string;
  agent_version: string;
  dt: string;
  status: "done" | "failed";
  json_data: AiLogJsonData;
  ai_title: string;
  flow_id: string | null;
  flow_command: string | null;
  trace_id?: string | null;
};

export type EventLogRow = {
  id: string;
  event_domain: string;
  event_id: string;
  event_type: string;
  event_action: string;
  title: string;
  items_id: string | null;
  subject_type: string;
  subject_id: string | null;
  actor_type: string;
  actor_id: string | null;
  occurred_at_utc: string;
  received_at_utc: string;
  status: "accepted" | "ignored";
  ignore_reason: string | null;
  payload_json: Record<string, unknown>;
  trace_id: string | null;
};

export type TechnicalLog = {
  id: number;
  trace_id: string | null;
  dt: string;
  severity_text: string;
  service: string;
  source: string;
  operation: string;
  status: "started" | "done" | "failed" | "skipped";
  duration_ms: number | null;
  message: string;
  json_data: Record<string, unknown>;
  expires_at_utc: string;
};

export type ModelProviderMode = "internal" | "external";

export type AppSettings = {
  display_timezone: string;
  model_provider_mode: ModelProviderMode;
  inbox_text_provider: "groq";
  inbox_text_model: string;
  inbox_image_provider: "openai";
  inbox_image_model: string;
  external_ai: {
    groq_configured: boolean;
    openai_configured: boolean;
  };
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  display_timezone: "Europe/Moscow",
  model_provider_mode: "internal",
  inbox_text_provider: "groq",
  inbox_text_model: "openai/gpt-oss-120b",
  inbox_image_provider: "openai",
  inbox_image_model: "gpt-4.1-mini",
  external_ai: {
    groq_configured: false,
    openai_configured: false,
  },
};

export type DrawSceneSummary = {
  name: string;
  title: string;
  updated_at_utc: string;
  size_bytes: number;
};

export type DrawScene = DrawSceneSummary & {
  scene: Record<string, unknown>;
};

export type BraiApiError = Error & {
  status?: number;
};

function authPayload<T extends Record<string, unknown>>(base: T, context?: AuthOnboardingContext): T & Partial<AuthOnboardingContext> {
  const preliminaryUserId = context?.preliminaryUserId || context?.duplicatePreliminaryUserId;
  return {
    ...base,
    ...(context?.name ? { name: context.name } : {}),
    ...(preliminaryUserId ? { preliminaryUserId } : {}),
    ...(context?.preliminaryClaimToken ? { preliminaryClaimToken: context.preliminaryClaimToken } : {}),
    ...(context?.deviceFingerprint ? { deviceFingerprint: context.deviceFingerprint } : {}),
  };
}

/**
 * Wraps the Brai HTTP API with typed client methods.
 */
export class BraiApi {
  constructor(private readonly baseUrl: string) {}

  async session(): Promise<AuthSession> {
    return this.request("/auth/session");
  }

  async requestOtp(email: string): Promise<OtpSendResult> {
    return this.request("/auth/otp/send", {
      method: "POST",
      json: { email },
    });
  }

  async verifyOtp(email: string, otp: string, context?: AuthOnboardingContext): Promise<AuthSession> {
    return this.request("/auth/otp/verify", {
      method: "POST",
      json: authPayload({ email, otp }, context),
    });
  }

  async testEmailLogin(email: string, context?: AuthOnboardingContext): Promise<AuthSession> {
    return this.request("/auth/test-email-login", {
      method: "POST",
      json: authPayload({ email }, context),
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

  async inboxWorkflow(inboxId: string): Promise<InboxWorkflowDetails> {
    return this.request(`/v1/inbox/${encodeURIComponent(inboxId)}/workflow`);
  }

  async aiLogs(limit = 50): Promise<{ logs: AiLog[] }> {
    return this.request(`/v1/ai-logs?limit=${encodeURIComponent(String(limit))}`);
  }

  async events(limit = 100): Promise<{ events: EventLogRow[] }> {
    return this.request(`/v1/events?limit=${encodeURIComponent(String(limit))}`);
  }

  async logs(limit = 100): Promise<{ logs: TechnicalLog[] }> {
    return this.request(`/v1/logs?limit=${encodeURIComponent(String(limit))}`);
  }

  async version(): Promise<AppVersionState> {
    return this.request("/v1/version");
  }

  async settings(): Promise<AppSettings> {
    return this.request("/v1/settings");
  }

  async updateSettings(patch: Partial<Pick<AppSettings, "display_timezone" | "model_provider_mode" | "inbox_text_model" | "inbox_image_model">>): Promise<AppSettings> {
    return this.request("/v1/settings", {
      method: "PATCH",
      json: patch,
    });
  }

  async draws(): Promise<{ draws: DrawSceneSummary[] }> {
    return this.request("/v1/draws");
  }

  async draw(name: string): Promise<DrawScene> {
    return this.request(`/v1/draws/${encodeURIComponent(name)}`);
  }

  async saveDraw(name: string, scene: Record<string, unknown>): Promise<DrawScene> {
    return this.request(`/v1/draws/${encodeURIComponent(name)}`, {
      method: "POST",
      json: { scene },
    });
  }

  async renameDraw(name: string, nextName: string): Promise<DrawScene> {
    return this.request(`/v1/draws/${encodeURIComponent(name)}/rename`, {
      method: "POST",
      json: { name: nextName },
    });
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
      const error = new Error(`brai_api_${response.status}`) as BraiApiError;
      error.name = response.status === 401 ? "UnauthorizedError" : "BraiApiError";
      error.status = response.status;
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

export type AppTargetApk = {
  file: string;
  version: number;
  version_code: number;
  release_key?: string | null;
  apk_build_kind?: string | null;
  preview_iteration?: number | null;
  release_url?: string | null;
  published_at: string | null;
  capabilities?: string[];
};

export type AppVersionState = {
  server_time_utc: string;
  version: string;
  ota_version?: string | null;
  parts: Record<VersionTypeId, number>;
  latest: Record<VersionTypeId, AppVersionLedgerRow | null>;
  target_apk: AppTargetApk | null;
  apk_release?: AppTargetApk | null;
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
