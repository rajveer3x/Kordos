import { generateKeyPairSync, randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";
import {
  issuer,
  oidcClientId,
  oidcClientSecret,
} from "./tests/e2e/oidc-fixture.js";

const baseURL = `http://127.0.0.1:${process.env.WEB_PORT ?? 4317}`;

const githubWorkspace = (process.env.TEST_GITHUB_WORKSPACE ??= randomUUID());
const githubKey = (process.env.TEST_GITHUB_KEY ??= generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString());

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
        "**/meetings-and-actions.spec.ts",
        "**/inbox-and-deadlines.spec.ts",
        "**/connectors.spec.ts",
        "**/github-activity-and-actions.spec.ts",
        "**/calendar-and-gmail.spec.ts",
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
    {
      name: "meetings",
      testMatch: "**/meetings-and-actions.spec.ts",
      dependencies: ["risks"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "inbox",
      testMatch: "**/inbox-and-deadlines.spec.ts",
      dependencies: ["meetings"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "connectors",
      testMatch: "**/connectors.spec.ts",
      dependencies: ["inbox"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "github",
      testMatch: "**/github-activity-and-actions.spec.ts",
      dependencies: ["connectors"],
      use: { actionTimeout: 10_000 },
    },
    {
      name: "google",
      testMatch: "**/calendar-and-gmail.spec.ts",
      dependencies: ["github"],
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
      CONNECTOR_TOKEN_KEY: Buffer.alloc(32, 13).toString("base64url"),
      CONNECTOR_FIXTURE_URL: `http://127.0.0.1:${process.env.TEST_CONNECTOR_PORT ?? 4493}/`,
      CONNECTOR_FIXTURE_WEBHOOK_SECRET:
        "kordos-connector-fixture-signing-secret",
      GOOGLE_CLIENT_ID: "kordos-google-test-client",
      GOOGLE_CLIENT_SECRET: "kordos-google-test-secret",
      GOOGLE_FIXTURE_URL: `http://127.0.0.1:${process.env.TEST_GOOGLE_PORT ?? 4495}/`,
      GITHUB_APP_ID: "4455",
      GITHUB_APP_PRIVATE_KEY: githubKey,
      GITHUB_INSTALLATIONS: JSON.stringify({ "8801": githubWorkspace }),
      GITHUB_FIXTURE_URL: `http://127.0.0.1:${process.env.TEST_GITHUB_PORT ?? 4494}/`,
      GITHUB_WEBHOOK_SECRET: "kordos-local-github-webhook-signing-secret",
      INBOX_EMAIL_URL: `http://127.0.0.1:${process.env.TEST_INBOX_EMAIL_PORT ?? 4492}/emails`,
      INBOX_EMAIL_KEY: "local-sink",
      INBOX_EMAIL_FROM: "kordos@example.test",
      BRIEF_MODEL_TIMEOUT_MS: "700",
      MEETING_TRANSCRIPTION_TIMEOUT_MS: "800",
    },
    url: `${baseURL}/api/health/ready`,
    timeout: 45_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
