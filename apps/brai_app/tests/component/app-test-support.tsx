import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "@/shared/api/braiApi";
import { clientDb, setMeta } from "@/shared/storage/db";

const otaPlugin = vi.hoisted(() => ({
  getState: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadApk: vi.fn(),
  downloadUpdate: vi.fn(),
  markReady: vi.fn(),
}));

const cmdPlugin = vi.hoisted(() => ({
  addListener: vi.fn(),
  beginAccountCredentialMode: vi.fn(),
  deleteAudio: vi.fn(),
  ensureAccess: vi.fn(),
  downloadAudio: vi.fn(),
  getSettings: vi.fn(),
  getState: vi.fn(),
  invalidateProviderCredentials: vi.fn(),
  openPermission: vi.fn(),
  openSettings: vi.fn(),
  preparePreliminaryProfile: vi.fn(),
  retryPendingAccountRevocation: vi.fn(),
  retryQueue: vi.fn(),
  probeProvider: vi.fn(),
  connectProvider: vi.fn(),
  disconnectProvider: vi.fn(),
  saveProvider: vi.fn(),
  setAccessKey: vi.fn(),
  setAuthenticatedMode: vi.fn(),
  syncProviderCredentials: vi.fn(),
  setOverlayEnabled: vi.fn(),
  setQueuePausedMode: vi.fn(),
  setVoiceOnlyMode: vi.fn(),
  testConnection: vi.fn(),
  testProvider: vi.fn(),
  updateSettings: vi.fn(),
}));

const androidCapabilitiesPlugin = vi.hoisted(() => ({
  getState: vi.fn(),
  openAccessibilitySettings: vi.fn(),
  openAppSettings: vi.fn(),
  openOverlaySettings: vi.fn(),
  requestMicrophone: vi.fn(),
  requestNotifications: vi.fn(),
}));

let cmdAccountUserId = "";
let cmdAccessGranted = true;

const actionsWidgetPlugin = vi.hoisted(() => ({
  acknowledgeStatusChanges: vi.fn(),
  addListener: vi.fn(),
  clear: vi.fn(),
  pendingStatusChanges: vi.fn(),
  saveSnapshot: vi.fn(),
}));

const audioPlay = vi.hoisted(() => vi.fn());

export { actionsWidgetPlugin, androidCapabilitiesPlugin, audioPlay, cmdPlugin, otaPlugin };

export async function clearBraiAppTestDatabase() {
  const db = clientDb();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn((name: string) => {
    if (name === "BraiCmd") return cmdPlugin;
    if (name === "BraiActionsWidget") return actionsWidgetPlugin;
    if (name === "BraiAndroidCapabilities") return androidCapabilitiesPlugin;
    return otaPlugin;
  }),
}));

function matchesMediaQuery(query: string): boolean {
  const maxWidth = query.match(/max-width:\s*(\d+)px/);
  if (maxWidth) return window.innerWidth <= Number(maxWidth[1]);
  const minWidth = query.match(/min-width:\s*(\d+)px/);
  if (minWidth) return window.innerWidth >= Number(minWidth[1]);
  return false;
}

export function braiCmdSettingsSnapshot() {
  return {
    native: true,
    overlayEnabled: true,
    permissions: {
      accessibility: false,
      overlay: false,
      microphone: true,
      notifications: true,
    },
    settings: {
      mainDictationEnabled: true,
      transcriptionMode: "cloud",
      transcriptionProviderId: "openai",
      transcriptionModel: "",
      transcriptionConfigured: true,
      providerProfiles: [],
      postProcessingEnabled: false,
      postProcessingPrompt: "",
      providerMode: "cloud",
      providerId: "openai",
      providerModel: "",
      providerBaseUrl: "",
      providerConfigured: true,
      mainIconOpacityPercent: 85,
      mainIconSizePercent: 100,
      contextIconOpacityPercent: 85,
      contextIconSizePercent: 100,
      processedAudioRetentionEnabled: false,
      processedAudioRetentionLimit: 25,
      contextActions: {
        voiceCommand: true,
        screenshotInbox: true,
        screenshotVoice: true,
        contextInbox: true,
        contextReply: true,
      },
    },
    stats: {
      requests: 0,
      audioSeconds: 0,
      audioMegabytes: 0,
      transcriptChars: 0,
      cloudRequests: 0,
      cloudInputChars: 0,
      cloudOutputChars: 0,
    },
    audio: [],
  };
}

export function setupBraiAppTest() {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.Capacitor;
    audioPlay.mockReset();
    audioPlay.mockResolvedValue(undefined);
    vi.stubGlobal("Audio", class MockAudio {
      preload = "";
      constructor(public src: string) {}
      play() { return audioPlay(); }
    });
    cleanup();
    Element.prototype.scrollIntoView = vi.fn();
    await clearBraiAppTestDatabase();
    await setMeta("currentUserId", "test-user");
    otaPlugin.getState.mockReset();
    otaPlugin.checkForUpdates.mockReset();
    otaPlugin.downloadApk.mockReset();
    otaPlugin.downloadUpdate.mockReset();
    otaPlugin.markReady.mockReset();
    cmdPlugin.openSettings.mockReset();
    cmdPlugin.addListener.mockReset();
    cmdPlugin.beginAccountCredentialMode.mockReset();
    cmdPlugin.deleteAudio.mockReset();
    cmdPlugin.ensureAccess.mockReset();
    cmdPlugin.downloadAudio.mockReset();
    cmdPlugin.getSettings.mockReset();
    cmdPlugin.getState.mockReset();
    cmdPlugin.invalidateProviderCredentials.mockReset();
    cmdPlugin.openPermission.mockReset();
    cmdPlugin.preparePreliminaryProfile.mockReset();
    cmdPlugin.retryPendingAccountRevocation.mockReset();
    cmdPlugin.retryQueue.mockReset();
    cmdPlugin.probeProvider.mockReset();
    cmdPlugin.connectProvider.mockReset();
    cmdPlugin.disconnectProvider.mockReset();
    cmdPlugin.saveProvider.mockReset();
    cmdPlugin.setAccessKey.mockReset();
    cmdPlugin.setAuthenticatedMode.mockReset();
    cmdPlugin.syncProviderCredentials.mockReset();
    cmdPlugin.setOverlayEnabled.mockReset();
    cmdPlugin.setQueuePausedMode.mockReset();
    cmdPlugin.setVoiceOnlyMode.mockReset();
    cmdPlugin.testConnection.mockReset();
    cmdPlugin.testProvider.mockReset();
    cmdPlugin.updateSettings.mockReset();
    androidCapabilitiesPlugin.getState.mockReset();
    androidCapabilitiesPlugin.openAccessibilitySettings.mockReset();
    androidCapabilitiesPlugin.openAppSettings.mockReset();
    androidCapabilitiesPlugin.openOverlaySettings.mockReset();
    androidCapabilitiesPlugin.requestMicrophone.mockReset();
    androidCapabilitiesPlugin.requestNotifications.mockReset();
    cmdPlugin.openSettings.mockResolvedValue({});
    cmdPlugin.addListener.mockResolvedValue({ remove: vi.fn(async () => undefined) });
    cmdAccountUserId = "";
    cmdAccessGranted = true;
    cmdPlugin.beginAccountCredentialMode.mockImplementation(async ({ userId }: { userId: string }) => {
      cmdAccountUserId = userId;
      cmdAccessGranted = false;
      return { accountCredentialsActive: true, overlayEnabled: false, queuePausedMode: true };
    });
    cmdPlugin.deleteAudio.mockResolvedValue({ ok: true, state: braiCmdSettingsSnapshot() });
    cmdPlugin.ensureAccess.mockResolvedValue({ accessGranted: true });
    cmdPlugin.downloadAudio.mockResolvedValue({ ok: true, path: "Downloads/Brai CMD/audio.m4a" });
    cmdPlugin.getSettings.mockResolvedValue(braiCmdSettingsSnapshot());
    cmdPlugin.getState.mockImplementation(async () => ({
      accountCredentialsActive: Boolean(cmdAccountUserId),
      accessGranted: cmdAccessGranted,
      deviceId: "test-install",
      clientVersion: "60006",
      appPackage: "world.brightos.brai.preview.b.work",
    }));
    cmdPlugin.invalidateProviderCredentials.mockResolvedValue({ ok: true });
    cmdPlugin.openPermission.mockResolvedValue(braiCmdSettingsSnapshot());
    cmdPlugin.preparePreliminaryProfile.mockResolvedValue({
      accessGranted: true,
      preliminaryStatus: "ready",
      preliminaryUserId: "prelim-test-user",
      preliminaryClaimToken: "prelim-claim-token",
      deviceFingerprint: "test-device",
    });
    cmdPlugin.retryPendingAccountRevocation.mockResolvedValue({ ok: true });
    cmdPlugin.retryQueue.mockResolvedValue({ queuePausedMode: false });
    cmdPlugin.probeProvider.mockResolvedValue({ ok: true, message: "Выберите модель", models: ["test-model"] });
    cmdPlugin.connectProvider.mockResolvedValue({ ok: true, message: "Подключено", model: "test-model", state: braiCmdSettingsSnapshot() });
    cmdPlugin.disconnectProvider.mockResolvedValue(braiCmdSettingsSnapshot());
    cmdPlugin.saveProvider.mockResolvedValue(braiCmdSettingsSnapshot());
    cmdPlugin.setAccessKey.mockImplementation(async ({ token, userId }: { token: string; userId: string }) => {
      cmdAccountUserId = token ? userId : "";
      cmdAccessGranted = Boolean(token);
      return { accessGranted: Boolean(token) };
    });
    cmdPlugin.syncProviderCredentials.mockResolvedValue({ ok: true, counts: { configured: 0, imported: 0, ignored: 0, failed: 0 } });
    cmdPlugin.setOverlayEnabled.mockImplementation(async ({ enabled }: { enabled: boolean }) => ({ overlayEnabled: enabled }));
    cmdPlugin.setQueuePausedMode.mockImplementation(async ({ enabled }: { enabled: boolean }) => ({ queuePausedMode: enabled }));
    cmdPlugin.setVoiceOnlyMode.mockImplementation(async ({ enabled }: { enabled: boolean }) => ({ voiceOnlyMode: enabled }));
    cmdPlugin.setAuthenticatedMode.mockImplementation(async ({ userId, enabled }: { userId: string; enabled: boolean }) => {
      if (cmdAccountUserId !== userId) throw Object.assign(new Error("account_changed"), { code: "account_changed" });
      await Promise.all([
        cmdPlugin.setOverlayEnabled({ enabled }),
        cmdPlugin.setVoiceOnlyMode({ enabled: !enabled }),
        cmdPlugin.setQueuePausedMode({ enabled: !enabled }),
      ]);
      return { overlayEnabled: enabled, voiceOnlyMode: !enabled, queuePausedMode: !enabled };
    });
    cmdPlugin.testConnection.mockResolvedValue({ ok: true, message: "ok" });
    cmdPlugin.testProvider.mockResolvedValue({ ok: true, message: "ok", models: ["test-model"], model: "test-model" });
    cmdPlugin.updateSettings.mockResolvedValue(braiCmdSettingsSnapshot());
    androidCapabilitiesPlugin.getState.mockResolvedValue({});
    androidCapabilitiesPlugin.openAccessibilitySettings.mockResolvedValue({});
    androidCapabilitiesPlugin.openAppSettings.mockResolvedValue({});
    androidCapabilitiesPlugin.openOverlaySettings.mockResolvedValue({});
    androidCapabilitiesPlugin.requestMicrophone.mockResolvedValue({ microphoneGranted: true });
    androidCapabilitiesPlugin.requestNotifications.mockResolvedValue({ notificationsGranted: true });
    actionsWidgetPlugin.acknowledgeStatusChanges.mockReset();
    actionsWidgetPlugin.addListener.mockReset();
    actionsWidgetPlugin.clear.mockReset();
    actionsWidgetPlugin.pendingStatusChanges.mockReset();
    actionsWidgetPlugin.saveSnapshot.mockReset();
    actionsWidgetPlugin.acknowledgeStatusChanges.mockResolvedValue({});
    actionsWidgetPlugin.addListener.mockResolvedValue({ remove: vi.fn(async () => undefined) });
    actionsWidgetPlugin.clear.mockResolvedValue({});
    actionsWidgetPlugin.pendingStatusChanges.mockResolvedValue({ changes: [] });
    actionsWidgetPlugin.saveSnapshot.mockResolvedValue({});
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      lastCheckStatus: "up_to_date",
    });
    otaPlugin.markReady.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      lastCheckStatus: "ready",
    });
    otaPlugin.checkForUpdates.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      availableBundleVersion: "0.0.11",
      updateAvailable: true,
      lastCheckStatus: "update_available",
    });
    otaPlugin.downloadUpdate.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      candidateBundleVersion: "0.0.11",
      lastCheckStatus: "candidate_ready_for_next_start",
    });
    otaPlugin.downloadApk.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      apkDownloadStatus: "downloading",
      activeOperation: "apk_download",
      lastCheckStatus: "apk_required",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/version")) {
        return new Response(JSON.stringify(testVersionState("0.0.10")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/brai-cmd/device-token")) {
        return new Response(JSON.stringify({ token: "authenticated-device-token", status: "pending" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/settings")) {
        return new Response(JSON.stringify(DEFAULT_APP_SETTINGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/ai/settings")) {
        return new Response(JSON.stringify({ model_provider_mode: "internal", text: null, vision: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/ai/providers")) {
        return new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    }));
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: matchesMediaQuery(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal("IntersectionObserver", class {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];
      disconnect() {}
      observe() {}
      takeRecords() { return []; }
      unobserve() {}
    });
    vi.stubGlobal("ResizeObserver", class {
      disconnect() {}
      observe() {}
      unobserve() {}
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 360 });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => document.body),
    });
    window.history.replaceState(null, "", "/");
    delete window.__BRAI_RUNTIME_CONFIG__;
    window.localStorage.clear();
    window.localStorage.setItem("brai_onboarding_state_v1", JSON.stringify({ complete: true, step: "login-check", history: [], path: null, profileVersion: null, voiceMode: null, name: "" }));
    document.cookie = "sidebar_state=; path=/; max-age=0";
    delete document.documentElement.dataset.sidebarState;
  });

  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.Capacitor;
    delete window.BraiAndroidBack;
    delete window.__BRAI_RUNTIME_CONFIG__;
    delete document.documentElement.dataset.sidebarState;
    delete document.documentElement.dataset.nativeAndroid;
    delete document.documentElement.dataset.braiStartupMounted;
  });
}

export function stubAndroidCapacitor() {
  const capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };
  vi.stubGlobal("Capacitor", capacitor);
  window.Capacitor = capacitor;
}

export async function openProfileMenu() {
  fireEvent.click(screen.getByRole("button", { name: /^Открыть левое меню/ }));
  return await waitFor(() => {
    const current = document.querySelector(".mobile-dock-overflow-sheet");
    expect(current).toBeInstanceOf(HTMLElement);
    return current as HTMLElement;
  });
}

export async function openProfileMenuItem(name: string | RegExp) {
  const drawer = await openProfileMenu();
  const accessibleName = typeof name === "string" && name.toLocaleLowerCase() === "brai cmd"
    ? /^Brai CMD$/i
    : name;
  fireEvent.click(within(drawer).getByRole("button", { name: accessibleName }));
}

export async function selectBraiCmdGroup(label: string) {
  await screen.findByText("Главная кнопка диктовки");
  fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
  const navigation = await screen.findByRole("navigation", { name: "Разделы настроек Brai CMD" });
  fireEvent.click(within(navigation).getByRole("button", { name: label }));
  await waitFor(() => expect(screen.queryByRole("navigation", { name: "Разделы настроек Brai CMD" })).not.toBeInTheDocument());
}

export async function openSettingsFromProfile() {
  await openProfileMenuItem("Настройки");
  await waitFor(() => expect(screen.getByRole("heading", { name: "Настройки" })).toBeInTheDocument());
}

export async function openEngineFromProfile() {
  await openProfileMenuItem(/^Engine(?:, доступно обновление| v.+)?$/);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument());
}

export function swipe(
  element: HTMLElement,
  {
    fromX,
    toX,
    fromY = 220,
    toY = 224,
  }: {
    fromX: number;
    toX: number;
    fromY?: number;
    toY?: number;
  },
) {
  const identifier = 1;
  fireEvent.touchStart(element, {
    changedTouches: [{ identifier, clientX: fromX, clientY: fromY }],
  });
  fireEvent.touchEnd(element, {
    changedTouches: [{ identifier, clientX: toX, clientY: toY }],
  });
}

export function cachedActivitiesState(id: string, title: string, descriptionMd = "") {
  return {
    server_time_utc: "2026-06-16T12:00:00.000Z",
    server_revision: 8,
    actions: [
      {
        id,
        title,
        description_md: descriptionMd,
        status: "New" as const,
        created_at_utc: "2026-06-16T10:00:00.000Z",
        updated_at_utc: "2026-06-16T10:00:00.000Z",
        completed_at_utc: null,
        sort_order: null,
        deleted_at_utc: null,
        restored_at_utc: null,
      },
    ],
    archived_actions: [],
  };
}

export function testVersionState(version: string) {
  const [canon, release, build] = version.split(".").map(Number);
  return {
    server_time_utc: "2026-06-29T12:00:00.000Z",
    version,
    ota_version: version,
    parts: { canon, release, build, apk: 1 },
    latest: {
      canon: null,
      release: null,
      build: null,
      apk: versionRow("apk", 1, "APK changes."),
    },
    target_apk: null,
    apk_release: null,
  };
}

function versionRow(type: "release" | "build" | "apk", version: number, shortChanges: string) {
  return {
    id: version,
    version_type_id: type,
    version,
    included_in_version_id: null,
    short_changes: shortChanges,
    detailed_changes: shortChanges,
    reason: shortChanges,
    released_at_utc: "2026-06-29T12:00:00.000Z",
    created_at_utc: "2026-06-29T12:00:00.000Z",
  };
}
