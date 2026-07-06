"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useReducedMotion } from "motion/react";
import { GlareHover } from "@/shared/ui/glare-hover";

export const SPLASH_MIN_VISIBLE_MS = 3000;
export const SPLASH_MAX_VISIBLE_MS = 5000;
const SPLASH_GLARE_DELAY_MS = 1000;
const SPLASH_GLARE_DURATION_MS = 1000;
const IS_TEST_RUNTIME = process.env.NODE_ENV === "test";
const SPLASH_TIMEOUT_CSS = `
@keyframes brai-startup-splash-timeout {
  0%, 99% { opacity: 1; pointer-events: auto; visibility: visible; }
  100% { opacity: 0; pointer-events: none; visibility: hidden; }
}
`;

export function AppStartupSplash({ ready }: { ready: boolean }) {
  const reduceMotion = Boolean(useReducedMotion()) || IS_TEST_RUNTIME;
  const [elapsed, setElapsed] = useState(false);
  const [expired, setExpired] = useState(false);
  const show = !expired && (!ready || !elapsed);
  const logoClassName = reduceMotion ? "h-auto w-64 sm:w-80" : "h-auto w-64 animate-in fade-in-0 zoom-in-95 duration-1000 sm:w-80";

  useEffect(() => {
    const minTimeout = window.setTimeout(() => setElapsed(true), SPLASH_MIN_VISIBLE_MS);
    const maxTimeout = window.setTimeout(() => setExpired(true), SPLASH_MAX_VISIBLE_MS);
    return () => {
      window.clearTimeout(minTimeout);
      window.clearTimeout(maxTimeout);
    };
  }, []);

  return show ? (
    <>
      <style>{SPLASH_TIMEOUT_CSS}</style>
      <div
        className="fixed inset-0 z-[9999] grid place-items-center bg-black"
        style={{ animation: `brai-startup-splash-timeout ${SPLASH_MAX_VISIBLE_MS}ms forwards` }}
        data-startup-splash
        aria-label="Brai"
      >
        <GlareHover
          width="auto"
          height="auto"
          background="transparent"
          borderColor="transparent"
          borderRadius="0"
          glareAngle={18}
          glareOpacity={1}
          glareSize={64}
          glareMaskImage="/brand/brai-logo-transparent.svg"
          transitionDuration={SPLASH_GLARE_DURATION_MS}
          autoPlayDelayMs={reduceMotion ? undefined : SPLASH_GLARE_DELAY_MS}
          interactive={false}
          playOnce
        >
          <Image
            className={logoClassName}
            src="/brand/brai-logo-transparent.svg"
            width="779"
            height="368"
            alt="Brai"
            priority={!IS_TEST_RUNTIME}
            draggable={false}
          />
        </GlareHover>
      </div>
    </>
  ) : null;
}
