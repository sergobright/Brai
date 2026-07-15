import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const browserHome = process.env.BRAI_BROWSER_HOME || "/srv/projects/brai";
const browserExecutable = process.env.BRAI_PLAYWRIGHT_EXECUTABLE_PATH
  || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const webServerPort = Number(process.env.BRAI_PLAYWRIGHT_PORT ?? 3201);
if (!Number.isInteger(webServerPort) || webServerPort < 1024 || webServerPort > 65535) {
  throw new Error("BRAI_PLAYWRIGHT_PORT must be an integer between 1024 and 65535");
}
const webServerUrl = `http://127.0.0.1:${webServerPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${webServerPort}`,
    url: webServerUrl,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    baseURL: webServerUrl,
    browserName: "chromium",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      executablePath: browserExecutable,
      env: {
        ...process.env,
        HOME: browserHome,
        XDG_CACHE_HOME: `${browserHome}/.cache`,
        XDG_CONFIG_HOME: `${browserHome}/.config`,
      },
    },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 820 } },
    },
  ],
});
