import { useSyncExternalStore } from "react";
import { isNativeShell } from "@/shared/platform/platform";

export type BraiRuntimeConfig = {
  appVersion?: string;
  environment?: string;
  previewSlot?: string;
  branch?: string;
  commit?: string;
  webApiBase?: string;
  androidApiBase?: string;
  otaChannel?: string;
};

declare global {
  interface Window {
    __BRAI_RUNTIME_CONFIG__?: BraiRuntimeConfig;
  }
}

export const APP_VERSION = process.env.NEXT_PUBLIC_BRAI_APP_VERSION || "unknown";
export const APP_BUILD = "1";
export const DEFAULT_WEB_API_BASE = process.env.NEXT_PUBLIC_BRAI_API || "/api";
export const DEFAULT_ANDROID_API_BASE =
  process.env.NEXT_PUBLIC_BRAI_ANDROID_API || "https://api.brai.one";
export const APP_ENVIRONMENT = process.env.NEXT_PUBLIC_BRAI_ENVIRONMENT || "prod";
export const APP_PREVIEW_SLOT = process.env.NEXT_PUBLIC_BRAI_PREVIEW_SLOT || "";
export const APP_BRANCH = process.env.NEXT_PUBLIC_BRAI_BRANCH || "";
export const APP_COMMIT = process.env.NEXT_PUBLIC_BRAI_COMMIT || "";
export const APP_OTA_CHANNEL = process.env.NEXT_PUBLIC_BRAI_OTA_CHANNEL || "app.brai.one/mobile-update";
export const ENVIRONMENT_BADGE_LABEL =
  APP_ENVIRONMENT === "dev"
    ? "Dev"
    : APP_ENVIRONMENT.startsWith("preview-") && APP_PREVIEW_SLOT
      ? APP_PREVIEW_SLOT
      : "";

export function runtimeConfig(): BraiRuntimeConfig {
  if (typeof window === "undefined") return {};
  return window.__BRAI_RUNTIME_CONFIG__ ?? {};
}

function runtimeValue(key: keyof BraiRuntimeConfig, fallback: string): string {
  return runtimeConfig()[key] || fallback;
}

export function appVersion(): string {
  return runtimeValue("appVersion", APP_VERSION);
}

export function useAppVersion(): string {
  return useSyncExternalStore(noopSubscribe, appVersion, () => APP_VERSION);
}

export function appEnvironment(): string {
  return runtimeValue("environment", APP_ENVIRONMENT);
}

export function appPreviewSlot(): string {
  return runtimeValue("previewSlot", APP_PREVIEW_SLOT);
}

export function environmentBadgeLabel(): string {
  const environment = appEnvironment();
  const previewSlot = appPreviewSlot();
  if (environment === "dev") return "Dev";
  if (environment.startsWith("preview-") && previewSlot) return previewSlot;
  return "";
}

export function useEnvironmentBadgeLabel(): string {
  return useSyncExternalStore(noopSubscribe, currentEnvironmentBadgeLabel, () => "");
}

export function defaultApiBase(): string {
  const webApiBase = runtimeValue("webApiBase", DEFAULT_WEB_API_BASE);
  const androidApiBase = runtimeValue("androidApiBase", DEFAULT_ANDROID_API_BASE);
  if (typeof window === "undefined") return webApiBase;
  return isNativeShell() ? androidApiBase : webApiBase;
}

export function isProductionEnvironment(): boolean {
  return appEnvironment() === "prod";
}

function currentEnvironmentBadgeLabel(): string {
  return isProductionEnvironment() ? "" : environmentBadgeLabel();
}

function noopSubscribe(): () => void {
  return () => {};
}
