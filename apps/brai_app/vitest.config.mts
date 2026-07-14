import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  cacheDir: ".cache/vite",
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["./tests/setup.ts"],
    globals: true,
    hookTimeout: 20_000,
    maxWorkers: 3,
    testTimeout: 20_000,
  },
});
