import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";

type BraiCmdPlugin = {
  getState(): Promise<BraiCmdState>;
  getSettings(): Promise<BraiCmdSnapshot>;
  updateSettings(options: { patch: BraiCmdSettingsPatch }): Promise<BraiCmdSnapshot>;
  testConnection(): Promise<BraiCmdTestResult>;
  testProvider(options: { provider: BraiCmdProviderTestInput }): Promise<BraiCmdProviderTestResult>;
  probeProvider(options: { provider: BraiCmdProviderProbeInput }): Promise<BraiCmdProviderTestResult>;
  connectProvider(options: { provider: BraiCmdProviderConnectInput }): Promise<BraiCmdProviderConnectResult>;
  disconnectProvider(options: { providerId: BraiCmdProviderId }): Promise<BraiCmdSnapshot>;
  saveProvider(options: { provider: BraiCmdProviderSaveInput }): Promise<BraiCmdSnapshot>;
  deleteAudio(options: { id: string }): Promise<{ ok: boolean; state?: BraiCmdSnapshot }>;
  downloadAudio(options: { id: string }): Promise<{ ok: boolean; path?: string; message?: string }>;
  openPermission(options: { permission: BraiCmdPermissionKey }): Promise<BraiCmdSnapshot>;
  vibratePress(): Promise<BraiCmdState>;
  openSettings(): Promise<unknown>;
  preparePreliminaryProfile?(options: { displayName: string }): Promise<BraiCmdPreliminaryProfile>;
  ensureAccess(options: { displayName: string }): Promise<BraiCmdState>;
  beginAccountCredentialMode?(options: { userId: string }): Promise<BraiCmdState>;
  setAccessKey(options: { token: string; displayName: string; userId: string }): Promise<BraiCmdState>;
  syncProviderCredentials?(): Promise<BraiCmdProviderCredentialSyncResult>;
  invalidateProviderCredentials?(): Promise<{ ok: boolean }>;
  retryPendingAccountRevocation?(): Promise<{ ok: boolean }>;
  setAuthenticatedMode?(options: { userId: string; enabled: boolean }): Promise<BraiCmdState>;
  setOverlayEnabled(options: { enabled: boolean }): Promise<BraiCmdState>;
  setVoiceOnlyMode(options: { enabled: boolean }): Promise<BraiCmdState>;
  setQueuePausedMode(options: { enabled: boolean }): Promise<BraiCmdState>;
  retryQueue(): Promise<BraiCmdState>;
  addListener(eventName: "onboardingEvent", listenerFunc: (event: BraiCmdOnboardingEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "credentialRefreshRequired", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "stateChanged", listenerFunc: (snapshot: BraiCmdSnapshot) => void): Promise<PluginListenerHandle>;
};

const BraiCmd = registerPlugin<BraiCmdPlugin>("BraiCmd");

export type BraiCmdState = {
  native?: boolean;
  accountCredentialsActive?: boolean;
  accessGranted?: boolean;
  voiceOnlyMode?: boolean;
  queuePausedMode?: boolean;
  overlayEnabled?: boolean;
  deviceId?: string;
  clientVersion?: string;
  appPackage?: string;
};

export type BraiCmdPreliminaryProfile = BraiCmdState & {
  preliminaryStatus?: "ready" | "duplicate";
  preliminaryUserId?: string;
  preliminaryClaimToken?: string;
  duplicateDevice?: boolean;
  deviceFingerprint?: string;
};

export type BraiCmdPermissionKey = "accessibility" | "overlay" | "microphone" | "notifications";
export type BraiCmdProviderMode = "cloud" | "key";
export type BraiCmdProviderId = "openai" | "groq" | "openrouter" | "gemini" | "custom-openai";

export type BraiCmdContextActions = {
  voiceCommand: boolean;
  screenshotInbox: boolean;
  screenshotVoice: boolean;
  contextInbox: boolean;
  contextReply: boolean;
};

export type BraiCmdSettings = {
  mainDictationEnabled: boolean;
  transcriptionMode: BraiCmdProviderMode;
  transcriptionProviderId: BraiCmdProviderId;
  transcriptionModel: string;
  transcriptionConfigured: boolean;
  providerProfiles: Array<{ providerId: BraiCmdProviderId; configured: boolean }>;
  postProcessingEnabled: boolean;
  postProcessingPrompt: string;
  providerMode: BraiCmdProviderMode;
  providerId: BraiCmdProviderId;
  providerModel: string;
  providerBaseUrl: string;
  providerConfigured: boolean;
  mainIconOpacityPercent: number;
  mainIconSizePercent: number;
  contextIconOpacityPercent: number;
  contextIconSizePercent: number;
  processedAudioRetentionEnabled: boolean;
  processedAudioRetentionLimit: number;
  contextActions: BraiCmdContextActions;
};

export type BraiCmdSettingsPatch = Omit<Partial<BraiCmdSettings>, "contextActions"> & {
  contextActions?: Partial<BraiCmdContextActions>;
};

export type BraiCmdStats = {
  requests: number;
  audioSeconds: number;
  audioMegabytes: number;
  transcriptChars: number;
  cloudRequests: number;
  cloudInputChars: number;
  cloudOutputChars: number;
};

export type BraiCmdAudioItem = {
  id: string;
  status: "queued" | "processed";
  title: string;
  bytes: number;
  megabytes: number;
};

export type BraiCmdSnapshot = BraiCmdState & {
  permissions: Record<BraiCmdPermissionKey, boolean>;
  settings: BraiCmdSettings;
  stats: BraiCmdStats;
  audio: BraiCmdAudioItem[];
};

export type BraiCmdTestResult = {
  ok: boolean;
  message: string;
  stages?: {
    server?: { status: "ok" | "error" | "skipped" };
    access?: { status: "ok" | "error" | "skipped" };
    contextDelivery?: { status: "ok" | "error" | "skipped" };
    cloudTranscription?: { status: "ok" | "error" | "skipped"; provider?: string; model?: string };
  };
};

export type BraiCmdProviderTestInput = {
  providerId: BraiCmdProviderId;
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

export type BraiCmdProviderCapability = "speech" | "text";

export type BraiCmdProviderProbeInput = Omit<BraiCmdProviderTestInput, "model"> & {
  capability: BraiCmdProviderCapability;
};

export type BraiCmdProviderConnectInput = BraiCmdProviderTestInput & {
  capability: BraiCmdProviderCapability;
};

export type BraiCmdProviderSaveInput = BraiCmdProviderTestInput & {
  providerMode: BraiCmdProviderMode;
};

export type BraiCmdProviderTestResult = BraiCmdTestResult & {
  providerId?: BraiCmdProviderId;
  model?: string;
  models?: string[];
  manualModel?: boolean;
};

export type BraiCmdProviderConnectResult = BraiCmdProviderTestResult & { state?: BraiCmdSnapshot };
export type BraiCmdProviderCredentialSyncResult = {
  ok: boolean;
  code?: string;
  message?: string;
  configuredProviderIds?: string[];
  importedProviderIds?: string[];
  ignoredProviderIds?: string[];
  failed?: Array<{ providerId: string; code: string }>;
  counts?: { configured: number; imported: number; ignored: number; failed: number };
};
export type BraiCmdOnboardingEvent = {
  type?: "voiceTextInserted" | "queueSaved";
  text?: string;
};

export async function getBraiCmdState(): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.getState();
  } catch {
    return null;
  }
}

export async function getBraiCmdSettings(): Promise<BraiCmdSnapshot | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.getSettings();
  } catch {
    return null;
  }
}

export async function updateBraiCmdSettings(patch: BraiCmdSettingsPatch): Promise<BraiCmdSnapshot | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.updateSettings({ patch });
  } catch {
    return null;
  }
}

export async function openBraiCmdPermission(permission: BraiCmdPermissionKey): Promise<BraiCmdSnapshot | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.openPermission({ permission });
  } catch {
    return null;
  }
}

export async function testBraiCmdConnection(): Promise<BraiCmdTestResult | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.testConnection();
  } catch {
    return null;
  }
}

export async function testBraiCmdProvider(provider: BraiCmdProviderTestInput): Promise<BraiCmdProviderTestResult | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.testProvider({ provider });
  } catch {
    return null;
  }
}

/** Validates provider credentials and returns models compatible with one capability. */
export async function probeBraiCmdProvider(provider: BraiCmdProviderProbeInput): Promise<BraiCmdProviderTestResult | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.probeProvider({ provider });
  } catch {
    return null;
  }
}

/** Verifies the selected model and persists the provider profile and role. */
export async function connectBraiCmdProvider(provider: BraiCmdProviderConnectInput): Promise<BraiCmdProviderConnectResult | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.connectProvider({ provider });
  } catch {
    return null;
  }
}

/** Deletes one saved provider key; native code moves active roles back to Brai cloud. */
export async function disconnectBraiCmdProvider(providerId: BraiCmdProviderId): Promise<BraiCmdSnapshot | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.disconnectProvider({ providerId });
  } catch {
    return null;
  }
}

export async function saveBraiCmdProvider(provider: BraiCmdProviderSaveInput): Promise<BraiCmdSnapshot | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.saveProvider({ provider });
  } catch {
    return null;
  }
}

export async function deleteBraiCmdAudio(id: string): Promise<BraiCmdSnapshot | null> {
  if (!isNativeAndroid()) return null;
  try {
    const result = await BraiCmd.deleteAudio({ id });
    return result.state ?? null;
  } catch {
    return null;
  }
}

export async function downloadBraiCmdAudio(id: string): Promise<BraiCmdTestResult | null> {
  if (!isNativeAndroid()) return null;
  try {
    const result = await BraiCmd.downloadAudio({ id });
    return { ok: result.ok, message: result.ok ? (result.path ?? "Сохранено") : (result.message ?? "Не удалось сохранить аудиозапись") };
  } catch {
    return null;
  }
}

/** Opens the Brai Cmd native settings screen when the app runs inside Android. */
export async function openBraiCmdSettings(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    await BraiCmd.openSettings();
    return true;
  } catch {
    return false;
  }
}

export async function ensureBraiCmdAccess(displayName: string): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.ensureAccess({ displayName });
  } catch {
    return null;
  }
}

export async function prepareBraiCmdPreliminaryProfile(displayName: string): Promise<BraiCmdPreliminaryProfile | null> {
  if (!isNativeAndroid() || !BraiCmd.preparePreliminaryProfile) return null;
  try {
    return await BraiCmd.preparePreliminaryProfile({ displayName });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "preliminary_unknown";
    console.warn("Brai CMD preliminary profile failed", { code });
    return null;
  }
}

/** Blocks local credentials while an authenticated account is being activated and synchronized. */
export async function beginBraiCmdAccountCredentialMode(userId: string): Promise<BraiCmdState | null> {
  if (!isNativeAndroid() || !BraiCmd.beginAccountCredentialMode) return null;
  try {
    return await BraiCmd.beginAccountCredentialMode({ userId });
  } catch {
    return null;
  }
}

export async function setBraiCmdAccessKey(token: string, displayName: string, userId: string): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setAccessKey({ token, displayName, userId });
  } catch {
    return null;
  }
}

/** Retries a logout revocation with the isolated encrypted token reserved for that request. */
export async function retryBraiCmdPendingAccountRevocation(): Promise<boolean> {
  if (!isNativeAndroid() || !BraiCmd.retryPendingAccountRevocation) return false;
  try {
    return (await BraiCmd.retryPendingAccountRevocation()).ok;
  } catch {
    return false;
  }
}

export async function syncBraiCmdProviderCredentials(): Promise<BraiCmdProviderCredentialSyncResult | null> {
  if (!isNativeAndroid()) return null;
  if (!BraiCmd.syncProviderCredentials) {
    return { ok: false, code: "native_update_required", message: "Обновите Android-приложение Brai." };
  }
  try {
    return await BraiCmd.syncProviderCredentials();
  } catch {
    return null;
  }
}

/** Removes account credential copies after a failed native sync so stale keys cannot be used. */
export async function invalidateBraiCmdProviderCredentials(): Promise<boolean> {
  if (!isNativeAndroid() || !BraiCmd.invalidateProviderCredentials) return false;
  try {
    return (await BraiCmd.invalidateProviderCredentials()).ok;
  } catch {
    return false;
  }
}

export async function setBraiCmdVoiceOnlyMode(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setVoiceOnlyMode({ enabled });
  } catch {
    return null;
  }
}

export async function setBraiCmdOverlayEnabled(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setOverlayEnabled({ enabled });
  } catch {
    return null;
  }
}

export async function vibrateBraiCmdPress(): Promise<void> {
  if (isNativeAndroid()) {
    try {
      await BraiCmd.vibratePress();
      return;
    } catch {
      // Fall through to the browser vibration API when the native bridge is unavailable.
    }
  }
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(16);
}

export async function setBraiCmdQueuePausedMode(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setQueuePausedMode({ enabled });
  } catch {
    return null;
  }
}

/** Applies the authenticated native mode only while the same account still owns the credential boundary. */
export async function setBraiCmdAuthenticatedMode(userId: string, enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  if (BraiCmd.setAuthenticatedMode) {
    try {
      return await BraiCmd.setAuthenticatedMode({ userId, enabled });
    } catch {
      return null;
    }
  }
  const [overlayState, voiceState, queueState] = await Promise.all([
    setBraiCmdOverlayEnabled(enabled),
    setBraiCmdVoiceOnlyMode(!enabled),
    setBraiCmdQueuePausedMode(!enabled),
  ]);
  return {
    ...overlayState,
    ...voiceState,
    ...queueState,
  };
}

export async function retryBraiCmdQueue(): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.retryQueue();
  } catch {
    return null;
  }
}

export async function listenBraiCmdOnboardingEvents(
  onEvent: (event: BraiCmdOnboardingEvent) => void,
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.addListener("onboardingEvent", onEvent);
  } catch {
    return null;
  }
}

export async function listenBraiCmdCredentialRefreshRequired(onRefresh: () => void): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.addListener("credentialRefreshRequired", onRefresh);
  } catch {
    return null;
  }
}

/** Subscribes to native queue and settings snapshots while the WebView stays mounted. */
export async function listenBraiCmdStateChanges(
  onSnapshot: (snapshot: BraiCmdSnapshot) => void,
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.addListener("stateChanged", onSnapshot);
  } catch {
    return null;
  }
}

function isNativeAndroid(): boolean {
  return isNativeShell() && platformName() === "android";
}
