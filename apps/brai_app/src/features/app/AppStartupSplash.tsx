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
  const logoClassName = "block h-full w-full select-none object-contain";

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
        <div
          className={reduceMotion ? "" : "animate-in fade-in-0 duration-700"}
          style={{ width: "min(20rem, calc(100vw - 3rem))", aspectRatio: "779 / 368" }}
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
      </div>
    </>
  ) : null;
}
