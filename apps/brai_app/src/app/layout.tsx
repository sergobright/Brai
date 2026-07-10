import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { resolveBraiIconAssets } from "@/shared/config/appIcons";
import "./globals.css";

const appInitScript = `(function(){try{window.__braiStartupStartedAt=window.performance&&window.performance.now?window.performance.now():Date.now();var root=document.documentElement;var nativeAndroid=window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform()&&window.Capacitor.getPlatform&&window.Capacitor.getPlatform()==="android";if(nativeAndroid){var onboarding=window.localStorage.getItem("brai_onboarding_state_v1");var onboardingComplete=false;if(onboarding){try{onboardingComplete=!!JSON.parse(onboarding).complete;}catch(error){}}if(!onboardingComplete){root.dataset.theme="dark";root.dataset.sidebarState="collapsed";return;}}var theme=window.localStorage.getItem("brai_theme_mode")||window.localStorage.getItem("bright_os_theme_mode");var systemDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;root.dataset.theme=theme==="dark"||theme==="light"?theme:(systemDark?"dark":"light");root.dataset.sidebarState="collapsed";}catch(error){}})();`;
const iconAssets = resolveBraiIconAssets();

export const metadata: Metadata = {
  title: "Brai",
  description: "Приватное приложение Brai",
  applicationName: "Brai",
  appleWebApp: {
    capable: true,
    title: "Brai",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: iconAssets.favicon, sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: iconAssets.faviconDark, sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: dark)" },
    ],
    apple: [{ url: iconAssets.icon192, sizes: "192x192", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#000000" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

const earlyPaintStyle = "html,body{min-height:100%;margin:0;background:#050607;color-scheme:dark light}html[data-theme=light],html[data-theme=light] body{background:#f7f7f3;color-scheme:light}html[data-theme=dark],html[data-theme=dark] body{background:#050607;color-scheme:dark}";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="preload" as="image" href="/brand/brai-logo-transparent.svg" />
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- runtime config must load before the reused static bundle */}
        <script src="/brai-runtime-config.js" />
        <style
          dangerouslySetInnerHTML={{
            __html: earlyPaintStyle,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: appInitScript,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
