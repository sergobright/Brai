import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { resolveBrightOsIconAssets } from "@/shared/config/appIcons";
import "./globals.css";

const appInitScript = `(function(){try{var root=document.documentElement;var theme=window.localStorage.getItem("bright_os_theme_mode");var systemDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;root.dataset.theme=theme==="dark"||theme==="light"?theme:(systemDark?"dark":"light");root.dataset.sidebarState="collapsed";}catch(error){}})();`;
const iconAssets = resolveBrightOsIconAssets();

export const metadata: Metadata = {
  title: "Bright OS",
  description: "Приватное приложение Bright OS",
  applicationName: "Bright OS",
  appleWebApp: {
    capable: true,
    title: "Bright OS",
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
    { media: "(prefers-color-scheme: light)", color: "#e6e6e6" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

const earlyPaintStyle = "html,body{min-height:100%;margin:0;background:#050607;color-scheme:dark light}";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
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
