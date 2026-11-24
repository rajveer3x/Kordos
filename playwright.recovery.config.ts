import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/operations",
  globalSetup: "./tests/e2e/oidc-fixture.ts",
  workers: 1,
  timeout: 240_000,
  use: { trace: "retain-on-failure" },
});
