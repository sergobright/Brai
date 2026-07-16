"use client";

import { useEffect, useState } from "react";
import { GlareHover } from "@/shared/ui/glare-hover";

export const SPLASH_MIN_VISIBLE_MS = 3000;
export const SPLASH_MAX_VISIBLE_MS = 5000;
const SPLASH_GLARE_DELAY_MS = 1000;
const SPLASH_GLARE_DURATION_MS = 1000;
const SPLASH_TIMEOUT_CSS = `
@keyframes brai-startup-logo-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes brai-startup-logo-glare {
  from { transform: translateX(-180%) rotate(18deg); }
  to { transform: translateX(250%) rotate(18deg); }
}
.brai-startup-glare > div:last-child > div {
  animation: brai-startup-logo-glare ${SPLASH_GLARE_DURATION_MS}ms linear ${SPLASH_GLARE_DELAY_MS}ms both;
}
@keyframes brai-startup-splash-timeout {
  0%, 99% { opacity: 1; pointer-events: auto; visibility: visible; }
  100% { opacity: 0; pointer-events: none; visibility: hidden; }
}
`;

type AppStartupSplashProps = {
  onIntroComplete?: () => void;
  persist?: boolean;
  ready: boolean;
};

type StartupWindow = Window & { __braiStartupStartedAt?: number };

function remainingStartupTime(totalMs: number): number {
  const startedAt = (window as StartupWindow).__braiStartupStartedAt;
  if (typeof startedAt !== "number") return totalMs;
  const now = window.performance?.now?.() ?? Date.now();
  return Math.max(0, totalMs - (now - startedAt));
}

export function AppStartupSplash({ onIntroComplete, persist = false, ready }: AppStartupSplashProps) {
  const [introComplete, setIntroComplete] = useState(false);
  const [expired, setExpired] = useState(false);
  const show = persist || (!expired && (!ready || !introComplete));

  useEffect(() => {
    document.documentElement.dataset.braiStartupMounted = "true";
  }, []);

  useEffect(() => {
    const maxTimeout = window.setTimeout(() => setExpired(true), remainingStartupTime(SPLASH_MAX_VISIBLE_MS));
    return () => window.clearTimeout(maxTimeout);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setIntroComplete(true);
      onIntroComplete?.();
    }, remainingStartupTime(SPLASH_MIN_VISIBLE_MS));
    return () => window.clearTimeout(timeout);
  }, [onIntroComplete]);

  return show ? (
    <>
      <style>{SPLASH_TIMEOUT_CSS}</style>
      <div
        className="fixed inset-0 z-[9999] grid place-items-center bg-black"
        style={{ animation: !persist ? `brai-startup-splash-timeout ${SPLASH_MAX_VISIBLE_MS}ms forwards` : undefined }}
        data-startup-splash
        aria-label="Brai"
      >
        <div
          data-startup-logo
          style={{
            width: "min(20rem, calc(100vw - 3rem))",
            aspectRatio: "779 / 368",
            animation: "brai-startup-logo-fade 1000ms linear both",
          }}
        >
          <GlareHover
            width="100%"
            height="100%"
            background="transparent"
            borderColor="transparent"
            borderRadius="0"
            glareAngle={18}
            glareOpacity={1}
            glareSize={64}
            glareMaskImage="/brand/brai-logo-transparent.svg"
            transitionDuration={SPLASH_GLARE_DURATION_MS}
            interactive={false}
            playOnce
            className="brai-startup-glare border-0"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- native decode keeps startup geometry and timing stable. */}
            <img
              className="block h-full w-full select-none object-contain"
              src="/brand/brai-logo-transparent.svg"
              alt="Brai"
              width="779"
              height="368"
              decoding="sync"
              fetchPriority="high"
              draggable={false}
            />
          </GlareHover>
        </div>
      </div>
    </>
  ) : null;
}
