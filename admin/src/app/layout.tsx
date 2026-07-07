import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

const appInitScript = `(function(){try{var root=document.documentElement;var saved=window.localStorage.getItem("brai_theme_mode");var theme=saved==="dark"||saved==="light"?saved:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");root.dataset.theme=theme;root.classList.toggle("dark",theme==="dark");}catch(error){}})();`;

export const metadata: Metadata = {
  title: "Brai Admin",
  description: "Техническая админ-панель Brai",
  applicationName: "Brai Admin",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="ru" data-theme="light" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
