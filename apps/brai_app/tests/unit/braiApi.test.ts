import { afterEach, describe, expect, it, vi } from "vitest";
import { BraiApi } from "@/shared/api/braiApi";
import type { PendingActivityEvent } from "@/shared/types/activities";
import type { PendingInboxEvent } from "@/shared/types/inbox";
import type { PendingTimerEvent } from "@/shared/types/timer";

describe("BraiApi", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts hung API requests", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));

    const request = new BraiApi("https://api.example.test").state();
    const expectation = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(8000);

    await expectation;
  });

  it("loads the runtime version endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          server_time_utc: "2026-06-29T12:00:00.000Z",
          version: "0.11.52",
          ota_version: "0.11.52",
          latest: { canon: null, release: null, build: null, apk: null },
          target_apk: { version: 2, file: "brai-v2.apk", release_url: "/releases/", capabilities: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await new BraiApi("https://api.example.test").version();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/v1/version");
    expect(response.ota_version).toBe("0.11.52");
    expect(response.target_apk?.file).toBe("brai-v2.apk");
  });

  it("binds and clears the expected owner for v1 HTTP and live requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
    const api = new BraiApi("https://api.example.test");

    api.setExpectedUserId("user/1");
    await api.state();

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("x-brai-expected-user-id")).toBe("user/1");
    expect(new URL(api.liveUrl()).searchParams.get("expected_user_id")).toBe("user/1");

    api.setExpectedUserId(null);
    await api.state();

    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has("x-brai-expected-user-id")).toBe(false);
    expect(new URL(api.liveUrl()).searchParams.has("expected_user_id")).toBe(false);
  });

  it("does not send an expected owner to auth requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = new BraiApi("https://api.example.test");
    api.setExpectedUserId("user-1");

    await api.session();

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("x-brai-expected-user-id")).toBe(false);
  });

  it("surfaces an expected-owner rejection as a scope change", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "user_scope_changed" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(new BraiApi("https://api.example.test").state()).rejects.toMatchObject({
      name: "UserScopeChangedError",
      message: "client_user_scope_changed",
      status: 409,
    });
  });

  it("sends explicit preview email login to the test auth endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false, user: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await new BraiApi("/api").testEmailLogin("primary@example.com");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/test-email-login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "primary@example.com" }),
    }));
  });

  it("sends onboarding preliminary context with auth requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ authenticated: false, user: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = new BraiApi("/api");

    await api.testEmailLogin("primary@example.com", {
      name: "Fixture User",
      duplicatePreliminaryUserId: "prelim-duplicate",
      preliminaryClaimToken: "claim-token",
      deviceFingerprint: "android-id",
    });
    await api.verifyOtp("primary@example.com", "123456", {
      name: "Fixture User",
      preliminaryUserId: "prelim-ready",
      preliminaryClaimToken: "claim-token",
      deviceFingerprint: "android-id",
    });

    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        email: "primary@example.com",
        name: "Fixture User",
        preliminaryUserId: "prelim-duplicate",
        preliminaryClaimToken: "claim-token",
        deviceFingerprint: "android-id",
      }),
    }));
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        email: "primary@example.com",
        otp: "123456",
        name: "Fixture User",
        preliminaryUserId: "prelim-ready",
        preliminaryClaimToken: "claim-token",
        deviceFingerprint: "android-id",
      }),
    }));
  });

  it("sends global stop metadata with synced timer events", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:2:stop"],
          ignored_events: [],
          server_revision: 2,
          state: {
            server_time_utc: "2026-06-15T08:00:00.000Z",
            server_revision: 2,
            timezone: "Europe/Moscow",
            active_session: null,
            elapsed_seconds: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncEvents({
      deviceId: "device",
      platform: "android",
      events: [
        {
          eventId: "device:2:stop",
          deviceId: "device",
          clientSequence: 2,
          type: "stop",
          occurredAtUtc: "2026-06-15T08:00:00.000Z",
          localTimerId: "device:timer:2",
          baseServerRevision: 1,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-15T08:00:00.000Z",
          lastSyncAttemptAtUtc: null,
          metadata: { global_stop: true },
        } satisfies PendingTimerEvent,
      ],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.events[0].metadata).toEqual({ global_stop: true });
  });

  it("sends focus session edit metadata with synced timer events", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:3:edit"],
          ignored_events: [],
          server_revision: 3,
          state: {
            server_time_utc: "2026-06-15T08:00:00.000Z",
            server_revision: 3,
            timezone: "Europe/Moscow",
            active_session: null,
            elapsed_seconds: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:3:edit",
          deviceId: "device",
          clientSequence: 3,
          type: "edit_session",
          occurredAtUtc: "2026-06-15T08:00:00.000Z",
          localTimerId: "device:timer:3",
          baseServerRevision: 2,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          enqueuedAtUtc: "2026-06-15T08:00:00.000Z",
          metadata: {
            focus_session_id: "session-1",
            started_at_utc: "2026-06-15T06:00:00.000Z",
            ended_at_utc: "2026-06-15T07:00:00.000Z",
          },
        } satisfies PendingTimerEvent,
      ],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.events[0]).toMatchObject({
      type: "edit_session",
      metadata: {
        focus_session_id: "session-1",
        started_at_utc: "2026-06-15T06:00:00.000Z",
        ended_at_utc: "2026-06-15T07:00:00.000Z",
      },
    });
  });

  it("sends pending action events to the activities sync endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:action:1"],
          ignored_events: [],
          server_revision: 1,
          server_time_utc: "2026-06-16T08:00:00.000Z",
          state: {
            server_time_utc: "2026-06-16T08:00:00.000Z",
            server_revision: 1,
            activities: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncActivityEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:action:1",
          deviceId: "device",
          clientSequence: 1,
          type: "create",
          occurredAtUtc: "2026-06-16T08:00:00.000Z",
          actionId: "action-1",
          payload: { title: "Фокус" },
          baseServerRevision: 0,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-16T08:00:00.000Z",
          lastSyncAttemptAtUtc: null,
        } satisfies PendingActivityEvent,
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("https://api.example.test/v1/activities/events/sync");
    expect(body.events[0]).toMatchObject({
      event_id: "device:action:1",
      activity_id: "action-1",
      change_type: "create",
      payload: { title: "Фокус" },
    });
  });

  it("sends pending delete action events to the activities sync endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:action:2"],
          ignored_events: [],
          server_revision: 2,
          server_time_utc: "2026-06-16T08:05:00.000Z",
          state: {
            server_time_utc: "2026-06-16T08:05:00.000Z",
            server_revision: 2,
            activities: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncActivityEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:action:2",
          deviceId: "device",
          clientSequence: 2,
          type: "delete",
          occurredAtUtc: "2026-06-16T08:05:00.000Z",
          actionId: "action-1",
          payload: {},
          baseServerRevision: 1,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-16T08:05:00.000Z",
          lastSyncAttemptAtUtc: null,
        } satisfies PendingActivityEvent,
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("https://api.example.test/v1/activities/events/sync");
    expect(body.events[0]).toMatchObject({
      event_id: "device:action:2",
      activity_id: "action-1",
      change_type: "delete",
      payload: {},
    });
  });

  it("sends pending restore action events to the activities sync endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:action:restore"],
          ignored_events: [],
          server_revision: 3,
          server_time_utc: "2026-06-16T08:06:00.000Z",
          state: {
            server_time_utc: "2026-06-16T08:06:00.000Z",
            server_revision: 3,
            activities: [],
            archived_activities: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncActivityEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:action:restore",
          deviceId: "device",
          clientSequence: 3,
          type: "restore",
          occurredAtUtc: "2026-06-16T08:06:00.000Z",
          actionId: "action-1",
          payload: {},
          baseServerRevision: 2,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-16T08:06:00.000Z",
          lastSyncAttemptAtUtc: null,
        } satisfies PendingActivityEvent,
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("https://api.example.test/v1/activities/events/sync");
    expect(body.events[0]).toMatchObject({
      event_id: "device:action:restore",
      activity_id: "action-1",
      change_type: "restore",
      payload: {},
    });
  });

  it("sends pending description action events to the activities sync endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:action:3"],
          ignored_events: [],
          server_revision: 3,
          server_time_utc: "2026-06-16T08:06:00.000Z",
          state: {
            server_time_utc: "2026-06-16T08:06:00.000Z",
            server_revision: 3,
            activities: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncActivityEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:action:3",
          deviceId: "device",
          clientSequence: 3,
          type: "update_description",
          occurredAtUtc: "2026-06-16T08:06:00.000Z",
          actionId: "action-1",
          payload: { description_md: "**важно**" },
          baseServerRevision: 2,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-16T08:06:00.000Z",
          lastSyncAttemptAtUtc: null,
        } satisfies PendingActivityEvent,
      ],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.events[0]).toMatchObject({
      change_type: "update_description",
      payload: { description_md: "**важно**" },
    });
  });

  it("sends pending reorder action events to the activities sync endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:action:4"],
          ignored_events: [],
          server_revision: 4,
          server_time_utc: "2026-06-16T08:07:00.000Z",
          state: {
            server_time_utc: "2026-06-16T08:07:00.000Z",
            server_revision: 4,
            activities: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncActivityEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:action:4",
          deviceId: "device",
          clientSequence: 4,
          type: "reorder",
          occurredAtUtc: "2026-06-16T08:07:00.000Z",
          actionId: "action-2",
          payload: { ordered_ids: ["action-2", "action-1"] },
          baseServerRevision: 3,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-16T08:07:00.000Z",
          lastSyncAttemptAtUtc: null,
        } satisfies PendingActivityEvent,
      ],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.events[0]).toMatchObject({
      change_type: "reorder",
      payload: { ordered_ids: ["action-2", "action-1"] },
    });
  });

  it("sends pending inbox events to the inbox sync endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          acknowledged_event_ids: ["device:inbox:1"],
          ignored_events: [],
          server_revision: 1,
          server_time_utc: "2026-06-16T08:00:00.000Z",
          state: {
            server_time_utc: "2026-06-16T08:00:00.000Z",
            server_revision: 1,
            inbox: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await new BraiApi("https://api.example.test").syncInboxEvents({
      deviceId: "device",
      platform: "web",
      events: [
        {
          eventId: "device:inbox:1",
          deviceId: "device",
          clientSequence: 1,
          type: "create",
          occurredAtUtc: "2026-06-16T08:00:00.000Z",
          inboxId: "inbox-1",
          payload: { title: "Входящее" },
          baseServerRevision: 0,
          payloadVersion: 1,
          status: "pending",
          attemptCount: 0,
          lastError: null,
          enqueuedAtUtc: "2026-06-16T08:00:00.000Z",
          lastSyncAttemptAtUtc: null,
        } satisfies PendingInboxEvent,
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("https://api.example.test/v1/inbox/events/sync");
    expect(body.events[0]).toMatchObject({
      event_id: "device:inbox:1",
      inbox_id: "inbox-1",
      type: "create",
      payload: { title: "Входящее" },
    });
  });
});
