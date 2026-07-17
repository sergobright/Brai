import type {
  GoalData,
  HistoryData,
  PendingTimerEvent,
  TimerState,
  TimerSyncResponse,
} from "@/shared/types/timer";
import type { ActivitiesState, ActivitiesSyncResponse, PendingActivityEvent } from "@/shared/types/activities";
import { normalizeContextDecisionsState, type ContextDecisionsState, type ContextDecisionsWireState, type ContextResolutionRequest, type ContextResolutionResponse, type GoalPlanResponse } from "@/shared/types/contextDecisions";
import type { InboxState, InboxSyncResponse, InboxWorkflowDetails, PendingInboxEvent } from "@/shared/types/inbox";
import { normalizeRelationsState, type PendingRelationEvent, type RelationsState, type RelationsSyncResponse, type RelationsWireState, type RelationsWireSyncResponse } from "@/shared/types/relations";
import { captureRuntimeBearerToken, clearRuntimeBearerToken } from "@/shared/auth/runtimeBearerToken";
import { drainContextReviews, drainRelations } from "./pagination";
interface RequestOptions extends RequestInit {
  json?: unknown;
  timeoutMs?: number;
}
const REQUEST_TIMEOUT_MS = 8_000;
const PROVIDER_READ_TIMEOUT_MS = 20_000;
const PROVIDER_MUTATION_TIMEOUT_MS = 55_000;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthSession = {
  authenticated: boolean;
  user?: AuthUser | null;
};

export type BraiCmdDeviceToken = {
  token: string;
  status: "pending";
};

export type AuthOnboardingContext = {
  name?: string;
  preliminaryUserId?: string;
  duplicatePreliminaryUserId?: string;
  preliminaryClaimToken?: string;
  deviceFingerprint?: string;
};

export type OtpSendResult = {
  sent?: boolean;
  success?: boolean;
  expires_in_seconds?: number;
  resend_after_seconds?: number;
  resend_strategy?: "rotate" | "reuse";
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
  item_roles_id: number | null;
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

export type UserPreferences = {
  context_rail_width_px: number;
};

export type ArchiveRole = {
  id: number;
  title_system: string;
  title: string;
  description: string;
  payload_table: string;
  archived_count: number;
};

export type ArchivedRoleItem = {
  id: string;
  title: string;
  description: string;
  author: string;
  created_at_utc: string;
  updated_at_utc: string;
  deleted_at_utc: string | null;
  item_roles_id: number | null;
  role_status: string;
  role_system: string;
  role_title: string;
  payload: Record<string, unknown> | null;
};

export type ArchiveState = {
  roles: ArchiveRole[];
  selected_role: string | null;
  items: ArchivedRoleItem[];
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

export type AiProviderId = "openai" | "groq" | "openrouter" | "gemini";

export type AiCapability = "text" | "vision";

export type AiProfile = {
  provider_id: AiProviderId;
  model: string;
};

export type AiSettings = {
  model_provider_mode: ModelProviderMode;
  text: AiProfile | null;
  vision: AiProfile | null;
};

export type AiProviderCredential = {
  provider_id: AiProviderId;
  key_hint: string;
  verified_at_utc: string;
  updated_at_utc: string;
  in_use_by: string[];
};

export type AiModel = {
  id: string;
  name?: string;
  capabilities: string[];
};

export type AppSettings = {
  display_timezone: string;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  display_timezone: "Europe/Moscow",
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
  code?: string;
  status?: number;
};

export class UserScopeChangedError extends Error {
  status = 409;

  constructor() {
    super("client_user_scope_changed");
    this.name = "UserScopeChangedError";
  }
}

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
  private expectedUserId: string | null = null;

  constructor(private readonly baseUrl: string) {}

  setExpectedUserId(userId: string | null): void { this.expectedUserId = userId; }

  async session(): Promise<AuthSession> {
    const session = await this.request<AuthSession>("/auth/session");
    if (!session.authenticated) clearRuntimeBearerToken();
    return session;
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
    try {
      await this.request("/auth/logout", { method: "POST" });
    } finally {
      clearRuntimeBearerToken();
    }
  }
  async state(): Promise<TimerState> { return this.request("/v1/timer/state"); }
  async history(): Promise<HistoryData> { return this.request("/v1/sessions"); }
  async goal(): Promise<GoalData> { return this.request("/v1/goals/challenge"); }
  async activities(): Promise<ActivitiesState> { return fromActivitiesState(await this.request<ActivitiesApiState>("/v1/activities")); }
  async actions(): Promise<ActivitiesState> { return this.activities(); }
  async inbox(): Promise<InboxState> { return this.request("/v1/inbox"); }
  async relations(filters: { endpointItemsId?: string; relationTypeId?: string; status?: "active" | "ended"; cursor?: string } = {}): Promise<RelationsState> {
    if (filters.cursor) return this.relationPage(filters);
    const first = await this.relationPage(filters);
    return drainRelations(first, (cursor) => this.relationPage({ ...filters, cursor }));
  }

  private async relationPage(filters: { endpointItemsId?: string; relationTypeId?: string; status?: "active" | "ended"; cursor?: string }): Promise<RelationsState> {
    const query = new URLSearchParams();
    if (filters.endpointItemsId) query.set("endpoint_items_id", filters.endpointItemsId);
    if (filters.relationTypeId) query.set("relation_type_id", filters.relationTypeId);
    if (filters.status) query.set("status", filters.status);
    if (filters.cursor) query.set("cursor", filters.cursor);
    return normalizeRelationsState(await this.request<RelationsWireState>(`/v1/relations${query.size ? `?${query}` : ""}`));
  }

  async contextDecisions(status: "pending" | "audit" | "auto_accepted" | "audit_confirmed" = "pending"): Promise<ContextDecisionsState> {
    const requested = status ?? "pending";
    return drainContextReviews(await this.contextDecisionPage(requested),
      (pageStatus, cursor) => this.contextDecisionPage(pageStatus, cursor), requested);
  }

  private async contextDecisionPage(status: "pending" | "audit" | "auto_accepted" | "audit_confirmed", cursor?: string | null): Promise<ContextDecisionsState> {
    const query = new URLSearchParams({ status });
    if (cursor) query.set("cursor", cursor);
    return normalizeContextDecisionsState(await this.request<ContextDecisionsWireState>(`/v1/context-decisions?${query}`));
  }
  async resolveContextDecision(id: string, resolution: ContextResolutionRequest): Promise<ContextResolutionResponse> {
    return this.request(`/v1/context-decisions/${encodeURIComponent(id)}/resolve`, { method: "POST", json: resolution });
  }
  async resolveContextAudit(id: string, resolution: ContextResolutionRequest): Promise<ContextResolutionResponse> {
    return this.request(`/v1/context-audits/${encodeURIComponent(id)}/resolve`, { method: "POST", json: resolution });
  }
  async undoContextDecision(id: string, idempotencyKey: string): Promise<ContextResolutionResponse> { return this.request(`/v1/context-decisions/${encodeURIComponent(id)}/undo`, { method: "POST", json: { idempotency_key: idempotencyKey } }); }

  async requestGoalPlan(itemsId: string): Promise<GoalPlanResponse> {
    return this.request(`/v1/goals/${encodeURIComponent(itemsId)}/plan`, { method: "POST" });
  }

  async inboxWorkflow(inboxId: string): Promise<InboxWorkflowDetails> {
    return this.request(`/v1/inbox/${encodeURIComponent(inboxId)}/workflow`);
  }

  async activityWorkflow(activityId: string): Promise<InboxWorkflowDetails> {
    return this.request(`/v1/activities/${encodeURIComponent(activityId)}/workflow`);
  }

  async aiLogs(limit = 50): Promise<{ logs: AiLog[] }> {
    return this.request(`/v1/ai-logs?limit=${encodeURIComponent(String(limit))}`);
  }

  async events(limit = 100): Promise<{ events: EventLogRow[] }> {
    return this.request(`/v1/events?limit=${encodeURIComponent(String(limit))}`);
  }

  async itemEvents(itemId: string, limit = 200): Promise<{ events: EventLogRow[] }> {
    return this.request(`/v1/items/${encodeURIComponent(itemId)}/events?limit=${encodeURIComponent(String(limit))}`);
  }

  async preferences(): Promise<UserPreferences> {
    return this.request("/v1/preferences");
  }

  async updatePreferences(patch: UserPreferences): Promise<UserPreferences> {
    return this.request("/v1/preferences", { method: "PATCH", json: patch });
  }

  async archive(role = "activity"): Promise<ArchiveState> {
    return this.request(`/v1/archive?role=${encodeURIComponent(role)}`);
  }

  async logs(limit = 100): Promise<{ logs: TechnicalLog[] }> {
    return this.request(`/v1/logs?limit=${encodeURIComponent(String(limit))}`);
  }

  async version(): Promise<AppVersionState> {
    return this.request("/v1/version");
  }

  async versionHistory({ type, cursor, limit = 30 }: { type?: VersionHistoryTypeId | null; cursor?: string | null; limit?: number } = {}): Promise<VersionHistoryPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (type) query.set("type", type);
    if (cursor) query.set("cursor", cursor);
    return this.publicRequest(`/v1/version-history?${query}`);
  }

  async settings(): Promise<AppSettings> {
    return this.request("/v1/settings");
  }

  async aiProviders(): Promise<{ providers: AiProviderCredential[] }> {
    return this.request("/v1/ai/providers");
  }

  async saveAiProvider(providerId: AiProviderId, apiKey: string): Promise<void> {
    await this.request(`/v1/ai/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      json: { api_key: apiKey },
      timeoutMs: PROVIDER_MUTATION_TIMEOUT_MS,
    });
  }

  async deleteAiProvider(providerId: AiProviderId): Promise<void> {
    await this.request(`/v1/ai/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  }

  async aiModels(providerId: AiProviderId, capability: AiCapability): Promise<{ models: AiModel[] }> {
    return this.request(
      `/v1/ai/providers/${encodeURIComponent(providerId)}/models?capability=${encodeURIComponent(capability)}`,
      { timeoutMs: PROVIDER_READ_TIMEOUT_MS },
    );
  }

  async aiSettings(): Promise<AiSettings> {
    return this.request("/v1/ai/settings");
  }

  async updateAiSettings(settings: AiSettings): Promise<AiSettings> {
    return this.request("/v1/ai/settings", {
      method: "PATCH",
      json: settings,
      timeoutMs: PROVIDER_MUTATION_TIMEOUT_MS,
    });
  }

  async braiCmdDeviceToken(device: { deviceId: string; clientVersion?: string; appPackage?: string }): Promise<BraiCmdDeviceToken> {
    return this.request("/v1/brai-cmd/device-token", {
      method: "POST",
      json: device,
    });
  }

  async updateSettings(patch: Partial<Pick<AppSettings, "display_timezone">>): Promise<AppSettings> {
    return this.request("/v1/settings", {
      method: "PATCH",
      json: patch,
    });
  }

  async draws(): Promise<{ draws: DrawSceneSummary[] }> { return this.request("/v1/draws"); }
  async draw(name: string): Promise<DrawScene> { return this.request(`/v1/draws/${encodeURIComponent(name)}`); }

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
        device: devicePayload(params.deviceId, params.platform),
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
        device: devicePayload(params.deviceId, params.platform),
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
        device: devicePayload(params.deviceId, params.platform),
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

  async syncRelationEvents(params: {
    deviceId: string;
    platform: string;
    events: PendingRelationEvent[];
    lastKnownServerTimeUtc?: string | null;
  }): Promise<RelationsSyncResponse> {
    const response = await this.request<RelationsWireSyncResponse>("/v1/relations/events/sync", {
      method: "POST",
      json: {
        device: devicePayload(params.deviceId, params.platform),
        last_known_server_time_utc: params.lastKnownServerTimeUtc ?? null,
        events: params.events.map((event) => ({
          event_id: event.eventId,
          client_sequence: event.clientSequence,
          change_type: event.type,
          relation_id: event.relationId,
          occurred_at_utc: event.occurredAtUtc,
          base_server_revision: event.baseServerRevision,
          payload_version: event.payloadVersion,
          payload: event.payload,
        })),
      },
    });
    return { ...response, deferred_events: response.deferred_events ?? [], state: normalizeRelationsState(response.state) };
  }

  liveUrl(): string {
    const target = new URL(resolvePath(this.baseUrl, "/v1/live"), window.location.href);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    if (this.expectedUserId !== null) target.searchParams.set("expected_user_id", this.expectedUserId);
    return target.toString();
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { json, timeoutMs = REQUEST_TIMEOUT_MS, ...requestOptions } = options;
    const headers = new Headers(requestOptions.headers);
    if (json !== undefined) headers.set("content-type", "application/json");
    if (this.expectedUserId !== null && path.startsWith("/v1/") && requestOptions.credentials !== "omit") {
      headers.set("x-brai-expected-user-id", this.expectedUserId);
    }
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    if (requestOptions.signal?.aborted) abortRequest();
    requestOptions.signal?.addEventListener("abort", abortRequest, { once: true });
    const timeoutId = setTimeout(abortRequest, timeoutMs);
    let response: Response;

    try {
      response = await fetch(resolvePath(this.baseUrl, path), {
        ...requestOptions,
        headers,
        credentials: requestOptions.credentials ?? "include",
        signal: controller.signal,
        body: json === undefined ? requestOptions.body : JSON.stringify(json),
      });
      captureRuntimeBearerToken(response);
    } finally {
      clearTimeout(timeoutId);
      requestOptions.signal?.removeEventListener("abort", abortRequest);
    }

    if (!response.ok) {
      if (response.status === 409) {
        const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null;
        if (payload?.error === "user_scope_changed") throw new UserScopeChangedError();
      }
      const error = new Error(`brai_api_${response.status}`) as BraiApiError;
      try {
        const payload = await response.json() as { error?: unknown };
        if (typeof payload.error === "string") error.code = payload.error;
      } catch {
        // The status remains enough when an upstream proxy returns a non-JSON error page.
      }
      error.name = response.status === 401 ? "UnauthorizedError" : "BraiApiError";
      error.status = response.status;
      throw error;
    }

    if (response.status === 204) return undefined as T;

    return (await response.json()) as T;
  }

  private async publicRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request(path, { ...options, credentials: "omit" });
  }
}

interface ActivitiesApiState {
  server_time_utc: string;
  server_revision: number;
  activities: ActivitiesState["actions"];
  archived_activities?: ActivitiesState["archived_actions"];
  legacy_operations?: NonNullable<ActivitiesState["legacy_operations"]>;
  goals?: NonNullable<ActivitiesState["goals"]>;
  archived_goals?: NonNullable<ActivitiesState["archived_goals"]>;
}

interface ActivitiesApiSyncResponse {
  acknowledged_event_ids: string[];
  ignored_events: Array<{ event_id: string; reason: string }>;
  server_revision: number;
  server_time_utc: string;
  state: ActivitiesApiState;
}

export type VersionTypeId = "canon" | "release" | "build" | "apk";
export type VersionHistoryTypeId = "build" | "apk" | "macos" | "ios";

export type VersionHistoryType = {
  id: VersionHistoryTypeId;
  title: string;
};

export type VersionHistoryPullRequest = {
  id: number;
  role: "owner" | "support";
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author_login: string;
  state: string;
  is_draft: boolean;
  head_branch: string;
  base_branch: string;
  merge_commit_sha: string | null;
  created_at_utc: string;
  updated_at_utc: string;
  closed_at_utc: string | null;
  merged_at_utc: string | null;
};

export type VersionHistoryItem = {
  id: number;
  type: VersionHistoryTypeId;
  version: number;
  short_changes: string;
  detailed_changes: string;
  reason: string;
  released_at_utc: string;
  created_at_utc: string;
  work: {
    key: string;
    status: string;
    created_at_utc: string;
    updated_at_utc: string;
    finalized_at_utc: string | null;
  } | null;
  details: Array<{
    id: number;
    title: string;
    description: string;
    display_order: number;
    pull_request_id: number | null;
  }>;
  pull_requests: VersionHistoryPullRequest[];
  refs: Array<{
    source_branch: string | null;
    source_commit: string | null;
    target_branch: string | null;
    target_commit: string | null;
    created_at_utc: string;
  }>;
};

export type VersionHistoryPage = {
  items: VersionHistoryItem[];
  types: VersionHistoryType[];
  next_cursor: string | null;
};

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
  download_url?: string | null;
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
    actions: state.activities.filter((item) => (item.activity_type_id ?? "action") === "action"),
    archived_actions: state.archived_activities ?? [],
    legacy_operations: [
      ...state.activities.filter((item) => item.activity_type_id === "operation"),
      ...(state.legacy_operations ?? []),
    ],
    goals: state.goals ?? [],
    archived_goals: state.archived_goals ?? [],
  };
}

function devicePayload(deviceId: string, platform: string) {
  return {
    device_id: deviceId,
    platform,
    display_name: platform === "android" ? "Brai Android" : "Brai Web",
  };
}

function resolvePath(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (!baseUrl || baseUrl === "/") return cleanPath;
  return `${baseUrl.replace(/\/$/, "")}${cleanPath}`;
}
