"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

export const SPLASH_MIN_VISIBLE_MS = 3000;
export const SPLASH_MAX_VISIBLE_MS = 5000;
const IS_TEST_RUNTIME = process.env.NODE_ENV === "test";
const LOGO_FRAME_CLASS = "relative aspect-[779/368] w-64 max-w-[78vw] sm:w-80";
const SPLASH_TIMEOUT_CSS = `
@keyframes brai-startup-logo-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}

@keyframes brai-startup-logo-shimmer {
  0%, 35% { opacity: 0; transform: translateX(-140%); }
  55% { opacity: .32; }
  80%, 100% { opacity: 0; transform: translateX(140%); }
}

@keyframes brai-startup-splash-timeout {
  0%, 99% { opacity: 1; pointer-events: auto; visibility: visible; }
  100% { opacity: 0; pointer-events: none; visibility: hidden; }
}

.brai-startup-logo-frame {
  opacity: 0;
  animation: brai-startup-logo-in 700ms ease-out 120ms both;
}

.brai-startup-logo-frame::after {
  content: "";
  position: absolute;
  inset: -8%;
  pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.28) 50%, transparent 65%);
  animation: brai-startup-logo-shimmer 2600ms ease-in-out 900ms infinite;
}
`;

export function AppStartupSplash({ ready }: { ready: boolean }) {
  const [elapsed, setElapsed] = useState(false);
  const [expired, setExpired] = useState(false);
  const show = !expired && (!ready || !elapsed);

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
        <div className={`${LOGO_FRAME_CLASS} brai-startup-logo-frame overflow-hidden`}>
          <Image
            className="object-contain"
            src="/brand/brai-logo-transparent.svg"
            alt="Brai"
            fill
            sizes="(min-width: 640px) 20rem, 16rem"
            priority={!IS_TEST_RUNTIME}
            draggable={false}
          />
        </div>
      </div>
    </>
  ) : null;
}
