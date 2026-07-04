import { defineConfig, devices } from "@playwright/test";

const browserHome = process.env.BRAI_BROWSER_HOME || "/srv/projects/brai";

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
