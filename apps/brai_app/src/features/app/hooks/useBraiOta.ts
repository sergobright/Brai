"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkAndroidOtaUpdates,
  downloadAndroidApk,
  downloadAndroidOtaUpdate,
  getAndroidOtaState,
  installAndroidApk,
  notifyAndroidOtaReady,
  type BraiOtaState,
} from "@/shared/platform/ota";
import { platformName } from "@/shared/platform/platform";

const OTA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const OTA_STATE_POLL_MS = 5000;
const OTA_ACTIVE_POLL_MS = 250;

/**
 * Exposes Android OTA state plus the current web bundle metadata.
 */
export function useBraiOta() {
  const [otaState, setOtaState] = useState<BraiOtaState | null>(null);
  const [otaCheckedAt, setOtaCheckedAt] = useState<string | null>(null);
  const [otaRefreshing, setOtaRefreshing] = useState(false);
  const [bundlePublishedAt, setBundlePublishedAt] = useState<string | null>(null);
  const successfulCheckRef = useRef<string | null>(null);

  const refreshOtaStateOnce = useCallback(async () => {
    setOtaRefreshing(true);
    try {
      const state = (await checkAndroidOtaUpdates()) ?? (await getAndroidOtaState());
      setOtaState(state);
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
      if (state && !state.checkInProgress && !["checking", "check_failed"].includes(state.lastCheckStatus ?? "")) {
        const checkIdentity = `${state.lastCheckStatus}:${state.availableBundleVersion ?? ""}:${state.targetApkVersionCode ?? ""}`;
        if (successfulCheckRef.current !== checkIdentity) {
          successfulCheckRef.current = checkIdentity;
          setOtaCheckedAt(new Date().toISOString());
        }
      }
    }

    void refreshOtaState();
    if (platformName() !== "android") {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(
      () => void refreshOtaState(),
      otaState?.activeOperation || otaState?.checkInProgress ? OTA_ACTIVE_POLL_MS : OTA_STATE_POLL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [otaState?.activeOperation, otaState?.checkInProgress]);

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

  const downloadWebUpdateOnce = useCallback(async () => {
    const state = await downloadAndroidOtaUpdate();
    if (state) setOtaState(state);
    return state;
  }, []);

  const downloadApkOnce = useCallback(async () => {
    const state = await downloadAndroidApk();
    if (state) setOtaState(state);
    return state;
  }, []);

  const installApkOnce = useCallback(async () => {
    const state = await installAndroidApk();
    if (state) setOtaState(state);
    return state;
  }, []);

  return { bundlePublishedAt, downloadApkOnce, downloadWebUpdateOnce, installApkOnce, otaCheckedAt, otaRefreshing, otaState, refreshOtaStateOnce };
}
