import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

/**
 * End-to-end tests drive the built app in Chromium. Build first
 * (`pnpm build`); the preview server is started here.
 */
export default defineConfig({
  testDir: "e2e",
  // Each test boots its own Python, which takes a few seconds.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // Every test runs its own Python; more than a couple at once starves them of CPU.
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1400, height: 900 },
        // Set to use a Chromium that is already installed instead of Playwright's own.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: `pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
