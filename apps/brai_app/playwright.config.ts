import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const browserHome = process.env.BRAI_BROWSER_HOME || "/srv/projects/brai";
const browserExecutable = process.env.BRAI_PLAYWRIGHT_EXECUTABLE_PATH
  || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3201",
    url: "http://127.0.0.1:3201",
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    baseURL: "http://127.0.0.1:3201",
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
