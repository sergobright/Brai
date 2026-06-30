"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppVersionState, BrightOsApi } from "@/shared/api/brightOsApi";

const VERSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Polls the runtime version ledger exposed by the Bright OS API.
 */
export function useBrightOsVersion(api: BrightOsApi) {
  const [versionState, setVersionState] = useState<AppVersionState | null>(null);
  const [versionCheckedAt, setVersionCheckedAt] = useState<string | null>(null);
  const [versionRefreshing, setVersionRefreshing] = useState(false);
  const [versionError, setVersionError] = useState(false);

  const refreshVersionOnce = useCallback(async () => {
    setVersionRefreshing(true);
    try {
      const state = await api.version();
      setVersionState(state);
      setVersionCheckedAt(new Date().toISOString());
      setVersionError(false);
    } catch {
      setVersionError(true);
    } finally {
      setVersionRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    const refresh = () => void refreshVersionOnce();
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };

    refresh();
    const interval = window.setInterval(refresh, VERSION_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshVersionOnce]);

  return { refreshVersionOnce, versionCheckedAt, versionError, versionRefreshing, versionState };
}
