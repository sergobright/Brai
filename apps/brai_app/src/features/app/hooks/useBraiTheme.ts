"use client";

import { useEffect, useState } from "react";
import { isNativeShell, platformName } from "@/shared/platform/platform";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import type { ThemeMode } from "../appModel";

/**
 * Persists the Brai light/dark theme and platform marker on the document.
 */
export function useBraiTheme(authenticated: boolean) {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    const saved = getBraiLocalStorageItem("brai_theme_mode");
    return saved === "dark" || saved === "light" ? saved : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const nativeAndroid =
      document.documentElement.dataset.nativeAndroid === "true" ||
      (platformName() === "android" && isNativeShell());
    document.documentElement.dataset.theme = nativeAndroid && !authenticated
      ? "dark"
      : isOnboardingComplete()
        ? theme
        : "dark";
    setBraiLocalStorageItem("brai_theme_mode", theme);
  }, [authenticated, theme]);

  useEffect(() => {
    document.documentElement.dataset.platform = platformName();
    return () => {
      delete document.documentElement.dataset.platform;
    };
  }, []);

  return { setTheme, theme };
}

function isOnboardingComplete(): boolean {
  try {
    const state = getBraiLocalStorageItem("brai_onboarding_state_v1");
    return state ? Boolean(JSON.parse(state).complete) : false;
  } catch {
    return false;
  }
}
