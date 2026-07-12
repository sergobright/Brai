"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BraiApi, type OtpSendResult } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import Galaxy from "@/shared/ui/galaxy";
import { AuthPanel, authDarkThemeStyle } from "./chrome/AppChrome";

const AUTH_GALAXY_ACTIVE = {
  density: 2,
  glowIntensity: 0.2,
  hueShift: 140,
  mouseInteraction: false,
  mouseRepulsion: false,
  rotationSpeed: 0.1,
  saturation: 0,
  speed: 1,
  starSpeed: 1,
  twinkleIntensity: 0.3,
  repulsionStrength: 2.5,
  autoCenterRepulsion: 0,
} as const;

export function AuthPage() {
  const router = useRouter();
  const api = useMemo(() => new BraiApi(defaultApiBase()), []);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      setBusy(true);
      try {
        const session = await api.session();
        if (cancelled) return;
        if (session.authenticated) {
          router.replace("/");
          return;
        }
      } catch {
        // Show the auth form when the lightweight session check cannot complete.
      }
      if (!cancelled) {
        setReady(true);
        setBusy(false);
      }
    }

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [api, router]);

  async function onRequestOtp(email: string): Promise<OtpSendResult> {
    setBusy(true);
    try {
      return await api.requestOtp(email);
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyOtp(email: string, otp: string) {
    setBusy(true);
    try {
      const session = await api.verifyOtp(email, otp);
      if (!session.authenticated) throw new Error("auth_failed");
      router.replace("/");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="relative isolate grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10 text-foreground"
      style={authDarkThemeStyle}
      data-auth-page
    >
      <div className="auth-galaxy-background pointer-events-none absolute inset-0 z-0" aria-hidden="true">
        <Galaxy {...AUTH_GALAXY_ACTIVE} />
      </div>
      {ready ? (
        <div className="relative z-10 grid w-full max-w-md justify-items-center gap-4">
          <AuthPanel
            busy={busy}
            className="m-0"
            onRequestOtp={onRequestOtp}
            onVerifyOtp={onVerifyOtp}
          />
          <a className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline" href="https://brai.one/">
            На главную
          </a>
        </div>
      ) : null}
    </main>
  );
}
