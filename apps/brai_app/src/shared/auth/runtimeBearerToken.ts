"use client";

import { useSyncExternalStore } from "react";

let runtimeBearerToken: string | null = null;
const listeners = new Set<() => void>();

/** Captures the native Better Auth runtime token in memory without persisting it. */
export function captureRuntimeBearerToken(response: Response): void {
  const candidate = response.headers.get("set-auth-token");
  if (!candidate || candidate.length > 4096 || /\s/.test(candidate)) return;
  setRuntimeBearerToken(candidate);
}

/** Clears the in-memory runtime credential when the authenticated session ends. */
export function clearRuntimeBearerToken(): void {
  setRuntimeBearerToken(null);
}

/** Subscribes a runtime consumer to the current in-memory Better Auth bearer token. */
export function useRuntimeBearerToken(): string | null {
  return useSyncExternalStore(subscribe, currentRuntimeBearerToken, () => null);
}

function currentRuntimeBearerToken(): string | null {
  return runtimeBearerToken;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setRuntimeBearerToken(next: string | null): void {
  if (runtimeBearerToken === next) return;
  runtimeBearerToken = next;
  for (const listener of listeners) listener();
}
