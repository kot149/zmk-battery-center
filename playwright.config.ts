import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "on-first-retry"
  },
  webServer: {
    command: "bun dev --host 127.0.0.1 --port 1420",
    url: "http://127.0.0.1:1420",
    timeout: 120000,
    reuseExistingServer: !isCI
  }
});
