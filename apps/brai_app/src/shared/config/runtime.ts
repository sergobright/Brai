import { isNativeShell } from "@/shared/platform/platform";

export const APP_VERSION = process.env.NEXT_PUBLIC_BRAI_APP_VERSION || "unknown";
export const APP_BUILD = "1";
export const DEFAULT_WEB_API_BASE = process.env.NEXT_PUBLIC_BRAI_API || "/api";
export const DEFAULT_ANDROID_API_BASE =
  process.env.NEXT_PUBLIC_BRAI_ANDROID_API || "https://api.brightos.world";
export const APP_ENVIRONMENT = process.env.NEXT_PUBLIC_BRAI_ENVIRONMENT || "prod";
export const APP_PREVIEW_SLOT = process.env.NEXT_PUBLIC_BRAI_PREVIEW_SLOT || "";
export const APP_BRANCH = process.env.NEXT_PUBLIC_BRAI_BRANCH || "";
export const APP_COMMIT = process.env.NEXT_PUBLIC_BRAI_COMMIT || "";
export const APP_OTA_CHANNEL = process.env.NEXT_PUBLIC_BRAI_OTA_CHANNEL || "app.brightos.world/mobile-update";
export const ENVIRONMENT_BADGE_LABEL =
  APP_ENVIRONMENT === "dev"
    ? "Dev"
    : APP_ENVIRONMENT.startsWith("preview-") && APP_PREVIEW_SLOT
      ? APP_PREVIEW_SLOT
      : "";

export function defaultApiBase(): string {
  if (typeof window === "undefined") return DEFAULT_WEB_API_BASE;
  return isNativeShell() ? DEFAULT_ANDROID_API_BASE : DEFAULT_WEB_API_BASE;
}

export function isProductionEnvironment(): boolean {
  return APP_ENVIRONMENT === "prod";
}
