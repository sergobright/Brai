const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

/** Returns the bounded delay for the next authenticated Brai CMD bootstrap attempt. */
export function braiCmdBootstrapRetryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)];
}
