import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/admin",
  serverExternalPackages: ["pg"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
