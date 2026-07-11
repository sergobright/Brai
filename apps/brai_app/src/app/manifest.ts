import type { MetadataRoute } from "next";
import { resolveBraiIconAssets } from "@/shared/config/appIcons";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const iconAssets = resolveBraiIconAssets();

  return {
    name: "Brai",
    short_name: "Brai",
    description: "Приватное приложение Brai",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
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
