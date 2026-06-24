import type { MetadataRoute } from "next";
import { resolveBrightOsIconAssets } from "@/shared/config/appIcons";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const iconAssets = resolveBrightOsIconAssets();

  return {
    name: "Bright OS",
    short_name: "Bright OS",
    description: "Приватное приложение Bright OS",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#e6e6e6",
    theme_color: "#e6e6e6",
    icons: [
      {
        src: iconAssets.icon192,
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: iconAssets.icon512,
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: iconAssets.maskable192,
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: iconAssets.maskable512,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
