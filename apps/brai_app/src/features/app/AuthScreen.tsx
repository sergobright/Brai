"use client";

import type { OtpSendResult } from "@/shared/api/braiApi";
import Galaxy from "@/shared/ui/galaxy";
import { AuthPanel, authDarkThemeStyle } from "./chrome/AppChrome";
import { cx } from "./appUtils";

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

export function AuthScreen({
  busy,
  dataAuthPage = false,
  formVisible = true,
  layout = "page",
  mode = "otp",
  onAuthenticated,
  onEmailLogin,
  onRequestOtp,
  onVerifyOtp,
  showHomeLink = false,
}: {
  busy: boolean;
  dataAuthPage?: boolean;
  formVisible?: boolean;
  layout?: "page" | "embedded";
  mode?: "email" | "otp";
  onAuthenticated?: () => void;
  onEmailLogin?: (email: string) => Promise<void>;
  onRequestOtp: (email: string) => Promise<OtpSendResult>;
  onVerifyOtp: (email: string, otp: string) => Promise<void>;
  showHomeLink?: boolean;
}) {
  return (
    <div
      className={cx(
        "relative isolate grid place-items-center overflow-hidden bg-background text-foreground",
        layout === "page" ? "min-h-dvh px-4 py-10" : "min-h-0 flex-1 px-4 py-4",
      )}
      style={authDarkThemeStyle}
      data-auth-page={dataAuthPage ? true : undefined}
      data-theme="dark"
    >
      <div className="auth-galaxy-background pointer-events-none absolute inset-0 z-0" aria-hidden="true">
        <Galaxy {...AUTH_GALAXY_ACTIVE} />
      </div>
      {formVisible ? (
        <div className="relative z-10 grid w-full max-w-md justify-items-center gap-4">
          <AuthPanel
            busy={busy}
            className="m-0"
            mode={mode}
            onAuthenticated={onAuthenticated}
            onEmailLogin={onEmailLogin}
            onRequestOtp={onRequestOtp}
            onVerifyOtp={onVerifyOtp}
          />
          {showHomeLink ? (
            <a className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline" href="https://brai.one/">
              На главную
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
