import { defineConfig } from "@playwright/test";

const baseURL = `http://127.0.0.1:${process.env.WEB_PORT ?? 4317}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm dev",
    url: `${baseURL}/api/health/ready`,
    timeout: 45_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
