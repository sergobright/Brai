"use client";

import { useCallback, useEffect, useState } from "react";
import {
  checkAndroidOtaUpdates,
  getAndroidOtaState,
  notifyAndroidOtaReady,
  type BrightOtaState,
} from "@/shared/platform/ota";
import { platformName } from "@/shared/platform/platform";

const OTA_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Exposes Android OTA state plus the current web bundle metadata.
 */
export function useBrightOsOta() {
  const [otaState, setOtaState] = useState<BrightOtaState | null>(null);
  const [otaCheckedAt, setOtaCheckedAt] = useState<string | null>(null);
  const [otaRefreshing, setOtaRefreshing] = useState(false);
  const [bundlePublishedAt, setBundlePublishedAt] = useState<string | null>(null);

  const refreshOtaStateOnce = useCallback(async () => {
    setOtaRefreshing(true);
    try {
      const state = (await checkAndroidOtaUpdates()) ?? (await getAndroidOtaState());
      setOtaState(state);
      if (state) setOtaCheckedAt(new Date().toISOString());
    } finally {
      setOtaRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void notifyAndroidOtaReady();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshOtaState() {
      const state = await getAndroidOtaState();
      if (cancelled) return;
      setOtaState(state);
      if (state) setOtaCheckedAt(new Date().toISOString());
    }

    void refreshOtaState();
    if (platformName() !== "android") {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => void refreshOtaState(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (platformName() !== "android") return;
    const interval = window.setInterval(() => void refreshOtaStateOnce(), OTA_CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshOtaStateOnce]);

  useEffect(() => {
    let cancelled = false;
    async function loadBundleMetadata() {
      try {
        const response = await fetch("/metadata.json", { cache: "no-store" });
        if (!response.ok) return;
        const metadata = (await response.json()) as { publishedAt?: string };
        if (!cancelled) setBundlePublishedAt(metadata.publishedAt ?? null);
      } catch {
        if (!cancelled) setBundlePublishedAt(null);
      }
    }

    void loadBundleMetadata();
    return () => {
      cancelled = true;
    };
  }, []);

  return { bundlePublishedAt, otaCheckedAt, otaRefreshing, otaState, refreshOtaStateOnce };
}
