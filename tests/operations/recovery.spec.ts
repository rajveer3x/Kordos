import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  briefJobSchema,
  commentFeedSchema,
  proposalDetailSchema,
  workItemSchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  issuer,
  oidcClientId,
  oidcClientSecret,
  signIn,
  startOidcFixture,
} from "../e2e/oidc-fixture.js";

const exec = promisify(execFile);
const dbName = "kordos_recovery";
const dbUser = "kordos_migrator";
const password = "synthetic-migration-password";
const storageBucket = "rehearsal-private";

async function listen(server = createServer()) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port");
  return address.port;
}

function close(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function localPort() {
  const probe = createServer();
  try {
    return await listen(probe);
  } finally {
    await close(probe);
  }
}

async function makeStack(name: string) {
  const [dbPort, redisPort, storagePort] = await Promise.all(
    Array.from({ length: 3 }, () => localPort()),
  );
  const appPassword = "synthetic-app-password";
  const workerPassword = "synthetic-worker-password";
  const dbUrl = (role: string, secret: string) =>
    `postgres://${role}:${secret}@127.0.0.1:${dbPort}/${dbName}`;
  const env = {
    POSTGRES_DB: dbName,
    POSTGRES_USER: dbUser,
    POSTGRES_PASSWORD: password,
    POSTGRES_APP_PASSWORD: appPassword,
    POSTGRES_BRIEF_WORKER_PASSWORD: workerPassword,
    POSTGRES_PORT: String(dbPort),
    REDIS_PORT: String(redisPort),
    STORAGE_PORT: String(storagePort),
    STORAGE_BUCKET: storageBucket,
    STORAGE_ACCESS_KEY_ID: "rehearsal-access",
    STORAGE_SECRET_ACCESS_KEY: "rehearsal-storage-secret",
    STORAGE_REGION: "us-east-1",
    STORAGE_ENDPOINT: `http://127.0.0.1:${storagePort}`,
    DATABASE_URL: dbUrl("kordos_app", appPassword),
    BRIEF_WORKER_DATABASE_URL: dbUrl("kordos_brief_worker", workerPassword),
    MIGRATION_DATABASE_URL: dbUrl(dbUser, password),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  };
  const compose = (...args: string[]) =>
    exec(
      "docker",
      ["compose", "--env-file", ".env.example", "-p", name, ...args],
      {
        env: { ...process.env, ...env },
      },
    );
  return {
    env,
    compose,
    owner: postgres(env.MIGRATION_DATABASE_URL, { max: 1 }),
  };
}

function boot(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-24000);
    });
  }
  return { child, output: () => output };
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

async function body<T>(response: Promise<APIResponse>, status: number) {
  const result = await response;
  expect(result.status(), await result.text()).toBe(status);
  return (await result.json()) as T;
}

test("restores database and private objects, replays durable work, and keeps manual edits available", async ({
  browser,
}, info) => {
  const name = "kordos-rehearsal-" + randomUUID().slice(0, 8);
  const [source, target, apiPort, webPort, directory] = await Promise.all([
    makeStack(name + "-source"),
    makeStack(name + "-target"),
    localPort(),
    localPort(),
    mkdtemp(join(tmpdir(), "kordos-rehearsal-")),
  ]);
  const origin = `http://127.0.0.1:${webPort}`;
  let providerCalls = 0;
  const model = createServer((_request, response) => {
    providerCalls++;
    response.writeHead(503).end();
  });
  const modelPort = await listen(model);
  const account = {
    name: "Recovery Lead",
    email: "recovery-lead@example.test",
    email_verified: true,
  };
  const endOidc = await startOidcFixture({ lead: account }, origin);
  const options = {
    APP_ORIGIN: origin,
    API_PORT: String(apiPort),
    WEB_PORT: String(webPort),
    AUTH0_ISSUER: issuer,
    AUTH0_CLIENT_ID: oidcClientId,
    AUTH0_CLIENT_SECRET: oidcClientSecret,
    ENABLE_FOUNDATION_JOBS: "true",
    ENABLE_EXTERNAL_WRITES: "false",
    MODEL_INTERACTIVE_DAILY_LIMIT: "1",
    OPENAI_API_KEY: "synthetic-key",
    OPENAI_BRIEF_MODEL: "outage-fixture",
    OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1/`,
  };
  const processes: { label: string; process: ReturnType<typeof boot> }[] = [];
  function start(
    label: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ) {
    const process = boot(args, env, cwd);
    processes.push({ label, process });
    return process;
  }
  const counts = (db: typeof source.owner) =>
    db`
    SELECT
      (SELECT count(*) FROM public.workspaces) AS workspaces,
      (SELECT count(*) FROM public.work_items) AS work,
      (SELECT count(*) FROM public.documents) AS documents,
      (SELECT count(*) FROM public.document_attachments) AS attachments,
      (SELECT count(*) FROM public.audit_events) AS auditable_events,
      (SELECT count(*) FROM public.outbox) AS outbox,
      (SELECT count(*) FROM public.comments) AS comments,
      (SELECT count(*) FROM public.executions) AS executions
  `.then(([row]) => row);
  function api(stack: typeof source) {
    return start("api", ["--import", "tsx", "apps/api/src/index.ts"], {
      ...stack.env,
      ...options,
    });
  }
  function worker(stack: typeof source) {
    return start("worker", ["--import", "tsx", "apps/worker/src/index.ts"], {
      ...stack.env,
      ...options,
    });
  }
  const ready = () =>
    expect
      .poll(async () =>
        fetch(origin + "/api/health/ready")
          .then((response) => response.status)
          .catch(() => 0),
      )
      .toBe(200);
  const archives = join(directory, "storage");
  const dump = join(directory, "primary.dump");
  const storage = (stack: typeof source, operation: "snapshot" | "restore") =>
    exec(
      process.execPath,
      ["infra/recovery/storage.mjs", operation, archives],
      { env: stack.env },
    ).then(({ stdout }) => JSON.parse(stdout) as { objects: number });
  const headers = { Origin: origin };

  try {
    await source.compose("up", "-d", "--wait", "postgres", "storage");
    await exec(
      process.execPath,
      ["--import", "tsx", "packages/db/src/migrate.ts"],
      { env: source.env },
    );
    const originalApi = api(source);
    start("web", ["node_modules/vite/bin/vite.js"], options, "apps/web");
    await expect
      .poll(async () =>
        fetch(origin + "/api/health/ready")
          .then((response) => response.status)
          .catch(() => 0),
      )
      .toBe(503);
    expect(
      await fetch(origin + "/api/health/live").then(
        (response) => response.status,
      ),
    ).toBe(200);
    await source.compose("up", "-d", "--wait", "redis");
    await ready();
    let originalWorker = worker(source);
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await signIn(page, account, "/workspace");
    const workspaceId = await createTestWorkspace(page, "Recovery studio");
    const post = (path: string, data: object) =>
      page.request.post(path, {
        headers,
        data: { mutationId: randomUUID(), ...data },
      });
    const workspace = `/api/workspaces/${workspaceId}`;
    const { id: projectId } = await body<{ id: string }>(
      post(workspace + "/projects", {
        name: "Recovery project",
        visibility: "restricted",
        timeZone: "Asia/Kolkata",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
        description: null,
      }),
      201,
    );
    const project = `${workspace}/projects/${projectId}`;
    const evidenceText = "A synthetic source for disaster recovery.";
    const { id: documentId } = await body<{ id: string }>(
      post(project + "/documents", {
        action: "create",
        title: "Recovery source",
        content: evidenceText,
      }),
      200,
    );
    const document = `${project}/documents/${documentId}`;
    const file = Buffer.from("synthetic private attachment\n");
    const upload =
      document +
      "/attachments?" +
      new URLSearchParams({ name: "recovery.txt", mutationId: randomUUID() });
    const { id: attachmentId } = await body<{ id: string }>(
      page.request.post(upload, {
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        data: file,
      }),
      200,
    );
    const attachment = `${document}/attachments/${attachmentId}`;
    expect(await (await page.request.get(attachment)).body()).toEqual(file);

    const brief = async (title: string) => {
      const { id } = await body<{ id: string }>(
        post(project + "/briefs", { title, content: evidenceText }),
        202,
      );
      await expect
        .poll(
          async () =>
            briefJobSchema.parse(
              await body(page.request.get(`${project}/briefs/${id}`), 200),
            ).failure,
        )
        .toBe("provider_unavailable");
    };
    await brief("Model failure");
    await brief("Workspace quota reached");
    expect(providerCalls).toBe(1);
    expect(originalWorker.output()).toContain('"outcome":"limited"');
    expect(originalWorker.output()).toContain('"status":503');

    const fields = {
      title: "Before outage",
      description: null,
      kind: "task",
      status: "ready",
      ownerId: null,
      estimateDays: 1,
      deadline: null,
      commitment: null,
      blockerReason: null,
      blockerOwnerId: null,
      blockerResolution: null,
    };
    const { id: workId } = await body<{ id: string }>(
      post(project + "/work", fields),
      201,
    );
    const work = `${project}/work/${workId}`;
    const manual = { ...fields, title: "Manually edited during outage" };
    await body(
      page.request.patch(work, {
        headers,
        data: {
          ...manual,
          action: "edit",
          expectedVersion: 1,
          mutationId: randomUUID(),
        },
      }),
      200,
    );
    expect(
      workItemSchema.parse(await body(page.request.get(work), 200)).title,
    ).toBe(manual.title);
    const discussion = `${project}/discussions/task/${workId}`;
    const { cursor } = await body<{ cursor: string }>(
      page.request.get(discussion),
      200,
    );

    await stop(originalWorker.child);
    const restartStarted = performance.now();
    const pendingJob = randomUUID();
    const jobPath = `/api/foundation/jobs/${pendingJob}`;
    await body(post("/api/foundation/jobs", { id: pendingJob }), 202);
    expect(await body(page.request.get(jobPath), 200)).toMatchObject({
      status: "pending",
    });
    originalWorker = worker(source);
    await expect
      .poll(() =>
        body<{ status: string }>(page.request.get(jobPath), 200).then(
          ({ status }) => status,
        ),
      )
      .toBe("completed");
    const workerCatchupSeconds = (performance.now() - restartStarted) / 1000;
    await stop(originalWorker.child);

    await body(
      post(discussion, {
        action: "post",
        body: "Event after the saved cursor",
        mentionIds: [],
        parentId: null,
      }),
      200,
    );
    const feed =
      discussion +
      "/events?" +
      new URLSearchParams(cursor ? { after: cursor } : {});
    const before = commentFeedSchema.parse(
      await body(page.request.get(feed), 200),
    );
    expect(before.events).toHaveLength(1);
    const { id: proposalId } = await body<{ id: string }>(
      post(project + "/proposals", {
        workId,
        targetVersion: 2,
        command: {
          kind: "work.edit",
          values: { ...manual, title: "Recovered approval" },
        },
        evidence: [
          {
            kind: "document",
            projectId,
            id: documentId,
            anchor: { revision: 1, start: 0, end: evidenceText.length },
          },
        ],
      }),
      201,
    );
    const proposal = `${workspace}/proposals/${proposalId}`;
    const precondition = async () => {
      const { revision, version } = proposalDetailSchema.parse(
        await body(page.request.get(proposal), 200),
      );
      return { revision, expectedVersion: version };
    };
    await body(post(proposal + "/submit", await precondition()), 200);
    const { receiptId } = await body<{ receiptId: string }>(
      post(proposal + "/approve", await precondition()),
      202,
    );
    expect(
      proposalDetailSchema.parse(await body(page.request.get(proposal), 200))
        .status,
    ).toBe("approved");

    const baseline = await counts(source.owner);
    const recoveryPoint = Date.now();
    await source.compose(
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      dbUser,
      "-Fc",
      "-f",
      "/tmp/rehearsal.dump",
      dbName,
    );
    await source.compose("cp", "postgres:/tmp/rehearsal.dump", dump);
    expect(await storage(source, "snapshot")).toEqual({
      storageOperation: "snapshot",
      objects: 1,
    });
    const lostJob = randomUUID();
    await body(post("/api/foundation/jobs", { id: lostJob }), 202);
    const failure = Date.now();
    await stop(originalApi.child);
    await source.compose("stop", "postgres", "storage");

    await target.compose("up", "-d", "--wait");
    await target.compose("cp", dump, "postgres:/tmp/rehearsal.dump");
    await target.compose(
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--exit-on-error",
      "-U",
      dbUser,
      "-d",
      dbName,
      "/tmp/rehearsal.dump",
    );
    expect(await counts(target.owner)).toEqual(baseline);
    expect(await storage(target, "restore")).toEqual({
      storageOperation: "restore",
      objects: 1,
    });
    api(target);
    await ready();
    const restored = await browser.newContext({ baseURL: origin });
    const restoredPage = await restored.newPage();
    await signIn(restoredPage, account, `/w/${workspaceId}/workspace`);
    await expect(restoredPage).toHaveURL(/\/w\//);
    expect(await (await restoredPage.request.get(attachment)).body()).toEqual(
      file,
    );
    expect((await fetch(origin + attachment)).status).toBe(401);
    expect(
      commentFeedSchema.parse(await body(restoredPage.request.get(feed), 200)),
    ).toEqual(before);
    expect(
      (
        await restoredPage.request.get(`/api/foundation/jobs/${lostJob}`)
      ).status(),
    ).toBe(404);

    worker(target);
    await expect
      .poll(
        async () =>
          proposalDetailSchema.parse(
            await body(restoredPage.request.get(proposal), 200),
          ).status,
      )
      .toBe("applied");
    expect(
      workItemSchema.parse(await body(restoredPage.request.get(work), 200))
        .title,
    ).toBe("Recovered approval");
    const [receipt] = await target.owner`
      SELECT id, approval_audit_id, effect_event_id, outcome_audit_id FROM public.executions WHERE proposal_id = ${proposalId}
    `;
    expect(receipt).toMatchObject({
      id: receiptId,
      approval_audit_id: expect.any(String),
      effect_event_id: expect.any(String),
      outcome_audit_id: expect.any(String),
    });
    expect((await counts(target.owner))?.executions).toBe(baseline?.executions);
    const runtime = postgres(target.env.DATABASE_URL, { max: 1 });
    try {
      await expect(
        runtime`SELECT * FROM kordos_ops.backlog()`,
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await runtime.end({ timeout: 2 });
    }
    await target.compose(
      "cp",
      "infra/recovery/trace.sql",
      "postgres:/tmp/trace.sql",
    );
    const { stdout: lineage } = await target.compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      dbUser,
      "-d",
      dbName,
      "-At",
      "--set=ON_ERROR_STOP=1",
      `--set=workspace=${workspaceId}`,
      `--set=ref=${documentId}`,
      "--file=/tmp/trace.sql",
    );
    expect(lineage).toContain(receiptId);
    expect(lineage).toContain(String(receipt?.effect_event_id));
    expect(lineage).not.toContain(evidenceText);
    const rpoSeconds = (failure - recoveryPoint) / 1000;
    const rtoSeconds = (Date.now() - failure) / 1000;
    expect(rpoSeconds).toBeLessThanOrEqual(900);
    expect(rtoSeconds).toBeLessThanOrEqual(14400);
    const report = {
      rpoSeconds,
      rtoSeconds,
      workerCatchupSeconds,
      baseline,
      restoredObjects: 1,
      replayedEvents: before.events.length,
      appliedExecutions: 1,
      lostPostBackupMarkers: 1,
    };
    console.log(JSON.stringify(report));
    await info.attach("recovery-measurements", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  } finally {
    if (info.status !== info.expectedStatus)
      for (const { label, process } of processes)
        await info.attach(label, {
          body: process.output(),
          contentType: "text/plain",
        });
    await Promise.allSettled(
      processes.map(({ process }) => stop(process.child)),
    );
    await Promise.allSettled([
      source.owner.end({ timeout: 2 }),
      target.owner.end({ timeout: 2 }),
      endOidc(),
      close(model),
    ]);
    await Promise.all([
      source.compose("down", "--volumes"),
      target.compose("down", "--volumes"),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
});
