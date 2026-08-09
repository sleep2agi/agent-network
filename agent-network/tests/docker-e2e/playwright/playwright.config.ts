import { defineConfig } from "@playwright/test";

// All tests share the dashboard URL + state file — both are injected
// from docker-compose.yml so the runner is hermetic.
export default defineConfig({
  testDir: ".",
  // Keep browser scenarios out of Bun's default *.spec.ts discovery. These
  // files require Playwright's runner/fixtures and are executed only here.
  testMatch: "**/*.pw.ts",
  // Run sequentially: the agent-node has one inbox shared across all tests.
  // Parallel runs would race for /api/hub/tasks state.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["junit", { outputFile: "/results/junit.xml" }],
    ["html", { open: "never", outputFolder: "/results/html" }],
  ],
  use: {
    baseURL: process.env.DASHBOARD_URL || "http://dashboard:3000",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    // Speed up: don't wait for full network idle on every nav.
    navigationTimeout: 20_000,
  },
});
