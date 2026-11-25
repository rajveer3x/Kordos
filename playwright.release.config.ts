import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

const log = (process.env.KORDOS_RELEASE_SERVER_LOG ??= join(
  mkdtempSync(join(tmpdir(), "kordos-release-")),
  "server.log",
));

const server = base.webServer;
if (!server || Array.isArray(server))
  throw new Error("Expected one development web server.");

export default defineConfig({
  testDir: "tests/release",
  globalSetup: base.globalSetup,
  timeout: 900_000,
  workers: 1,
  use: base.use,
  webServer: {
    ...server,
    command: 'pnpm dev > "$KORDOS_RELEASE_SERVER_LOG" 2>&1',
    env: {
      ...server.env,
      KORDOS_RELEASE_SERVER_LOG: log,
      MODEL_INDEX_DAILY_LIMIT: "40000",
      MODEL_INTERACTIVE_DAILY_LIMIT: "5000",
      GROQ_API_KEY: "",
    },
  },
});
