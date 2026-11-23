import { defineConfig } from "@playwright/test";
import {
  issuer,
  oidcClientId,
  oidcClientSecret,
} from "./tests/e2e/oidc-fixture.js";

const baseURL = `http://127.0.0.1:${process.env.WEB_PORT ?? 4317}`;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/oidc-fixture.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    {
      name: "foundation",
      testIgnore: [
        "**/identity-tenancy.spec.ts",
        "**/projects-and-work.spec.ts",
        "**/dependencies-and-forecasts.spec.ts",
        "**/realtime-collaboration.spec.ts",
        "**/documents-and-decisions.spec.ts",
        "**/approvals-and-audit.spec.ts",
        "**/brief-to-plan.spec.ts",
        "**/project-activity-risks.spec.ts",
      ],
    },
    {
      name: "identity",
      testMatch: "**/identity-tenancy.spec.ts",
      dependencies: ["foundation"],
    },
    {
      name: "planning",
      testMatch: "**/projects-and-work.spec.ts",
      dependencies: ["identity"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "forecast",
      testMatch: "**/dependencies-and-forecasts.spec.ts",
      dependencies: ["planning"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "collaboration",
      testMatch: "**/realtime-collaboration.spec.ts",
      dependencies: ["forecast"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "knowledge",
      testMatch: "**/documents-and-decisions.spec.ts",
      dependencies: ["collaboration"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "reviews",
      testMatch: "**/approvals-and-audit.spec.ts",
      dependencies: ["knowledge"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "briefs",
      testMatch: "**/brief-to-plan.spec.ts",
      dependencies: ["reviews"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "risks",
      testMatch: "**/project-activity-risks.spec.ts",
      dependencies: ["briefs"],
      use: { actionTimeout: 10_000 },
    },
  ],
  webServer: {
    command: "pnpm dev",
    env: {
      APP_ORIGIN: baseURL,
      AUTH0_ISSUER: issuer,
      AUTH0_CLIENT_ID: oidcClientId,
      AUTH0_CLIENT_SECRET: oidcClientSecret,
      OPENAI_BASE_URL: `http://127.0.0.1:${process.env.TEST_BRIEF_MODEL_PORT ?? 4429}/v1/`,
      OPENAI_API_KEY: "test-brief-key",
      OPENAI_BRIEF_MODEL: "brief-fixture",
      BRIEF_MODEL_TIMEOUT_MS: "700",
    },
    url: `${baseURL}/api/health/ready`,
    timeout: 45_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
