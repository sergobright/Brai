export type BrightOsIconAssets = {
  favicon: string;
  faviconDark: string;
  icon192: string;
  icon512: string;
  maskable192: string;
  maskable512: string;
};

const productionIcons: BrightOsIconAssets = {
  favicon: "/favicon.png",
  faviconDark: "/favicon-dark.png",
  icon192: "/icons/Icon-192.png",
  icon512: "/icons/Icon-512.png",
  maskable192: "/icons/Icon-maskable-192.png",
  maskable512: "/icons/Icon-maskable-512.png",
};

const nonProductionIconDirs: Record<string, string> = {
  dev: "/icons/dev",
  "preview-a": "/icons/preview-a",
  "preview-b": "/icons/preview-b",
  "preview-c": "/icons/preview-c",
  "preview-d": "/icons/preview-d",
  "preview-e": "/icons/preview-e",
};

/** Returns the web/PWA icon set for the current Bright OS deployment environment. */
export function resolveBrightOsIconAssets(
  environment = process.env.NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT,
): BrightOsIconAssets {
  const iconDir = environment ? nonProductionIconDirs[environment] : undefined;
  if (!iconDir) return productionIcons;

  return {
    favicon: `${iconDir}/favicon.png`,
    faviconDark: `${iconDir}/favicon-dark.png`,
    icon192: `${iconDir}/Icon-192.png`,
    icon512: `${iconDir}/Icon-512.png`,
    maskable192: `${iconDir}/Icon-maskable-192.png`,
    maskable512: `${iconDir}/Icon-maskable-512.png`,
  };
}
