"use client";

import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";

export const ONBOARDING_STORAGE_KEY = "brai_onboarding_state_v1";

export type OnboardingStep =
  | "start"
  | "welcome-1"
  | "welcome-2"
  | "welcome-3"
  | "welcome-4"
  | "welcome-5"
  | "welcome-6"
  | "path"
  | "name"
  | "profile-version"
  | "cloud-login"
  | "self-hosted-key"
  | "setup-start"
  | "features"
  | "floating-buttons"
  | "demo-dictation"
  | "demo-save-screen"
  | "demo-chat-reply"
  | "demo-agent-command"
  | "special-settings"
  | "security"
  | "voice-intro"
  | "voice-choice"
  | "provider-key"
  | "local-server"
  | "cloud-privacy"
  | "overlay"
  | "accessibility-why"
  | "accessibility-blocked"
  | "accessibility-restricted"
  | "accessibility-enable"
  | "microphone"
  | "notifications"
  | "training-start"
  | "training-dictate"
  | "training-offline"
  | "training-queue"
  | "training-storage"
  | "voice-ready"
  | "login-check"
  | "locked"
  | "login"
  | "cmd-settings";

export type OnboardingPath = "new" | "existing" | null;
export type ProfileVersion = "cloud" | "self-hosted" | null;
export type VoiceMode = "provider" | "local" | "cloud" | null;

export type OnboardingState = {
  complete: boolean;
  step: OnboardingStep;
  history: OnboardingStep[];
  path: OnboardingPath;
  profileVersion: ProfileVersion;
  voiceMode: VoiceMode;
  name: string;
};

export const initialOnboardingState: OnboardingState = {
  complete: false,
  step: "start",
  history: [],
  path: null,
  profileVersion: null,
  voiceMode: null,
  name: "",
};

export function loadOnboardingState(): OnboardingState {
  if (typeof window === "undefined") return initialOnboardingState;
  try {
    const raw = getBraiLocalStorageItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return initialOnboardingState;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      complete: Boolean(parsed.complete),
      step: normalizeOnboardingStep(parsed.step) ?? "start",
      history: Array.isArray(parsed.history) ? parsed.history.map(normalizeOnboardingStep).filter(isDefinedOnboardingStep) : [],
      path: parsed.path === "new" || parsed.path === "existing" ? parsed.path : null,
      profileVersion: parsed.profileVersion === "cloud" || parsed.profileVersion === "self-hosted" ? parsed.profileVersion : null,
      voiceMode: parsed.voiceMode === "provider" || parsed.voiceMode === "local" || parsed.voiceMode === "cloud" ? parsed.voiceMode : null,
      name: typeof parsed.name === "string" ? parsed.name : "",
    };
  } catch {
    return initialOnboardingState;
  }
}

export function saveOnboardingState(state: OnboardingState): void {
  if (typeof window === "undefined") return;
  setBraiLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
}

/** Checks the locally entered display name before onboarding can continue. */
export function isValidOnboardingName(name: string): boolean {
  return /^[\p{L}\p{M}\p{N} ]+$/u.test(name) && (name.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2;
}

export function stepProgress(step: OnboardingStep): number {
  const index = orderedSteps.indexOf(step);
  if (index < 0) return 0;
  return Math.round(((index + 1) / orderedSteps.length) * 100);
}

function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && orderedSteps.includes(value as OnboardingStep);
}

function normalizeOnboardingStep(value: unknown): OnboardingStep | null {
  if (value === "cloud-password") return "cloud-login";
  if (value === "features") return "floating-buttons";
  return isOnboardingStep(value) ? value : null;
}

function isDefinedOnboardingStep(value: OnboardingStep | null): value is OnboardingStep {
  return value != null;
}

const orderedSteps: OnboardingStep[] = [
  "start",
  "welcome-1",
  "welcome-2",
  "welcome-3",
  "welcome-4",
  "welcome-5",
  "welcome-6",
  "path",
  "name",
  "profile-version",
  "cloud-login",
  "self-hosted-key",
  "setup-start",
  "floating-buttons",
  "demo-dictation",
  "demo-save-screen",
  "demo-chat-reply",
  "demo-agent-command",
  "special-settings",
  "security",
  "voice-intro",
  "voice-choice",
  "provider-key",
  "local-server",
  "cloud-privacy",
  "microphone",
  "overlay",
  "accessibility-why",
  "accessibility-blocked",
  "accessibility-restricted",
  "accessibility-enable",
  "notifications",
  "training-start",
  "training-dictate",
  "training-offline",
  "training-queue",
  "training-storage",
  "voice-ready",
  "login-check",
  "locked",
  "login",
  "cmd-settings",
];
