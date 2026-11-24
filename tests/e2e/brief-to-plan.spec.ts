import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  approvalQueue,
  auditPageSchema,
  briefJobSchema,
  briefQueue,
  graphSchema,
  proposalDetailSchema,
  reviewResponseSchema,
  workPageSchema,
  type ModelBrief,
} from "@kordos/contracts";
import { expect, test, type APIResponse } from "@playwright/test";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const groqFixture = process.env.TEST_GROQ_BRIEFS === "1";
const modelPort = Number(process.env.TEST_BRIEF_MODEL_PORT ?? 4429);
const quotes = [
  "🧭 Build the release checklist. Mira owns it, 2 workdays, due tomorrow.",
  "Write migration notes after the release checklist.",
  "The reviewer is TBD. Review screenshots after the release checklist.",
  "Prepare support copy after the release checklist.",
];
const content = quotes.join("\n");
const model: ModelBrief = {
  tasks: quotes.map((quote, index) => ({
    id: `task-${index}`,
    title: [
      "Release checklist",
      "Migration notes",
      "Review screenshots",
      "Support copy",
    ][index]!,
    description: null,
    owner: index === 0 ? "Mira" : null,
    estimateDays: index === 0 ? 2 : index === 1 ? 3 : null,
    estimateInferred: index === 1,
    deadline: index === 0 ? { kind: "relative", value: "tomorrow" } : null,
    quote,
  })),
  edges: [1, 2, 3].map((index) => ({
    predecessorId: "task-0",
    successorId: `task-${index}`,
  })),
};

test("a sourced brief survives a timeout, and the edited plan applies once through review", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  if (
    !baseURL ||
    !process.env.DATABASE_URL ||
    !process.env.REDIS_URL ||
    !process.env.MIGRATION_DATABASE_URL
  ) {
    throw new Error("Set the browser origin and test database and Redis URLs.");
  }
  const calls = new Map<string, number>();
  const server = createServer(async (request, response) => {
    try {
      const expectedKey = groqFixture ? "test-groq-key" : "test-brief-key";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { title, brief } = JSON.parse(payload.messages[1].content);
      calls.set(title, (calls.get(title) ?? 0) + 1);
      if (
        request.url !== "/v1/chat/completions" ||
        payload.response_format.json_schema.strict !== true ||
        brief !== content ||
        request.headers.authorization !== `Bearer ${expectedKey}` ||
        (groqFixture
          ? "store" in payload || payload.model !== "openai/gpt-oss-20b"
          : payload.store !== false)
      ) {
        response.writeHead(400).end();
        return;
      }
      if (title === "Manual rollout" || calls.get(title) === 1) return;
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(model), refusal: null },
            },
          ],
        }),
      );
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(modelPort, "127.0.0.1", resolve);
  });
  const lead = {
    name: "Mira",
    email: `mira-${randomUUID()}@example.test`,
    email_verified: true,
  };
  const outsider = {
    name: "Jo",
    email: `jo-${randomUUID()}@example.test`,
    email_verified: true,
  };
  const stopOidc = await startOidcFixture({ lead, outsider }, baseURL);
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const extractions = new Queue(briefQueue, { connection: redis });
  const approvals = new Queue(approvalQueue, { connection: redis });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const admin = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  const leadContext = await browser.newContext({ baseURL });
  const outsideContext = await browser.newContext({ baseURL });
  const page = await leadContext.newPage();
  const outside = await outsideContext.newPage();
  const headers = { Origin: baseURL };

  async function response<T>(
    result: Promise<APIResponse>,
    expected: number,
  ): Promise<T> {
    const received = await result;
    const body = await received.json();
    expect(received.status(), JSON.stringify(body)).toBe(expected);
    return body as T;
  }
  const post = (path: string, data: object) =>
    page.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });

  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(outside, outsider, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Brief Studio");
    const api = `/api/workspaces/${workspace}`;
    const { token } = await response<{ token: string }>(
      post(api + "/invitations", { email: outsider.email, role: "viewer" }),
      201,
    );
    await response(
      outside.request.post("/api/invitations/accept", {
        headers,
        data: { token },
      }),
      200,
    );
    const { id: project } = await response<{ id: string }>(
      post(api + "/projects", {
        name: "Release planning",
        visibility: "restricted",
        timeZone: "Asia/Kolkata",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
        description: null,
      }),
      201,
    );
    const projectApi = `${api}/projects/${project}`;
    const base = `/w/${workspace}/projects/${project}`;
    await page.goto(base);
    await page.getByRole("link", { name: "Add a brief" }).click();
    await page.getByLabel("Brief title").fill("Three release branches");
    await page.getByLabel("Brief text").fill(content);
    await page.getByRole("button", { name: "Extract a plan" }).click();
    await expect(
      page.getByText("The model timed out. The brief is saved."),
    ).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    const jobApi = `${projectApi}/briefs/${id}`;
    const readJob = async (path = jobApi) =>
      briefJobSchema.parse(await response(page.request.get(path), 200));
    const failed = await readJob();
    expect(failed.content).toBe(content);
    expect(failed.attempt).toBe(1);
    expect(
      await outside.request.get(jobApi).then((result) => result.status()),
    ).toBe(404);
    await expect(
      runtime`SELECT * FROM public.brief_jobs`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT * FROM kordos_briefs.pending()`,
    ).rejects.toMatchObject({ code: "42501" });

    const retry = { expectedVersion: failed.version, mutationId: randomUUID() };
    const retried = await Promise.all([
      response(post(jobApi + "/retry", retry), 202),
      response(post(jobApi + "/retry", retry), 202),
    ]);
    expect(retried[0]).toEqual(retried[1]);
    await expect(page.getByText("Candidates ready")).toBeVisible();
    const ready = await readJob();
    expect(ready.attempt).toBe(2);
    expect(ready.candidates?.edges).toHaveLength(3);
    expect(ready.candidates?.tasks[2]?.ownerId).toBeNull();
    expect(ready.candidates?.tasks[0]?.ownerId).toBeTruthy();
    expect(ready.candidates?.tasks[0]?.certainty.deadline).toBe("inferred");
    expect(ready.candidates?.tasks[1]?.certainty.estimate).toBe("inferred");
    const local = new Date(
      Date.parse(ready.capturedAt) + (5 * 60 + 30) * 60 * 1000,
    );
    local.setUTCDate(local.getUTCDate() + 1);
    expect(ready.candidates?.tasks[0]?.deadline).toBe(
      local.toISOString().slice(0, 10),
    );
    await expect(
      page.getByRole("group", { name: "Task 3" }).getByLabel("Owner"),
    ).toHaveValue("");
    await page.getByRole("link", { name: "Open evidence" }).nth(1).click();
    await expect(page).toHaveURL(/documents\/evidence\//);
    await expect(
      page.getByRole("link", { name: "Open full revision" }),
    ).toBeVisible();
    await expect(page.getByRole("blockquote")).toHaveText(quotes[1]!);
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Plan candidates" }),
    ).toBeVisible();
    await extractions.add(
      "extract",
      { id, attempt: 2 },
      { jobId: `replay-${id}`, removeOnComplete: true },
    );
    await expect
      .poll(async () => extractions.getJob(`replay-${id}`))
      .toBeUndefined();
    expect(calls.get("Three release branches")).toBe(2);

    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 840 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
    }
    await page
      .getByRole("group", { name: "Task 2" })
      .getByLabel("Task title")
      .fill("Publish migration notes");
    await page
      .getByRole("group", { name: "Task 4" })
      .getByRole("button", { name: "Split task" })
      .click();
    await page
      .getByRole("group", { name: "Task 5" })
      .getByLabel("Task title")
      .fill("Review support copy");
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    await page
      .getByRole("group", { name: "Task 6" })
      .getByRole("button", { name: "Remove task" })
      .click();
    await page
      .getByLabel("Predecessor")
      .selectOption({ label: "Publish migration notes" });
    await page
      .getByLabel("Successor")
      .selectOption({ label: "Release checklist" });
    await page.getByRole("button", { name: "Add dependency" }).click();
    await page.getByRole("button", { name: "Save plan draft" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Dependencies contain a cycle",
    );
    const readWork = async () =>
      workPageSchema.parse(
        await response(page.request.get(projectApi + "/work"), 200),
      );
    expect((await readWork()).items).toHaveLength(0);
    await page
      .getByRole("button", {
        name: "Remove dependency: Release checklist follows Publish migration notes",
      })
      .click();
    await page.getByRole("button", { name: "Save plan draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Plan from Three release branches" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit proposal" }).click();
    await page
      .getByRole("group", { name: "Task 3" })
      .getByLabel("Description")
      .fill("Check the captured screenshots.");
    await page.getByRole("button", { name: "Save plan draft" }).click();
    await expect(
      page.getByText("Check the captured screenshots.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(
      page.getByRole("button", { name: "Approve plan" }),
    ).toBeVisible();
    const proposalId = new URL(page.url()).pathname.split("/").at(-1)!;
    const proposalApi = `${api}/proposals/${proposalId}`;
    const readPlan = async () => {
      const plan = proposalDetailSchema.parse(
        await response(page.request.get(proposalApi), 200),
      );
      if (plan.kind !== "plan") throw new Error("Expected a plan proposal.");
      return plan;
    };
    const pending = await readPlan();
    expect(
      await outside.request.get(proposalApi).then((result) => result.status()),
    ).toBe(404);
    const decision = {
      revision: pending.revision,
      expectedVersion: pending.version,
    };
    const [first, second] = await Promise.all([
      response(post(proposalApi + "/approve", decision), 202),
      response(post(proposalApi + "/approve", decision), 202),
    ]);
    expect(first).toEqual(second);
    const receipt = reviewResponseSchema.parse(first).receiptId!;
    await expect(page.getByText("Applied", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Publish migration notes" }),
    ).toBeVisible();
    const replayId = `replay-${receipt}`;
    await approvals.add(
      "apply",
      { id: receipt },
      { jobId: replayId, removeOnComplete: true },
    );
    await expect.poll(async () => approvals.getJob(replayId)).toBeUndefined();
    const applied = await readPlan();
    expect(applied.receipt?.id).toBe(receipt);
    expect(Object.keys(applied.createdWork ?? {})).toHaveLength(5);
    const work = await readWork();
    expect(work.items).toHaveLength(5);
    expect(
      work.items.find(({ title }) => title === "Review screenshots")?.owner,
    ).toBeNull();
    await page.getByRole("link", { name: "Publish migration notes" }).click();
    const origin = page.getByRole("region", { name: "Source brief" });
    await expect(
      origin.getByRole("link", { name: "Three release branches" }),
    ).toBeVisible();
    await expect(origin.getByRole("blockquote")).toHaveText(quotes[1]!);
    expect(
      await outside.request
        .get(`${projectApi}/work/${work.items[0]!.id}/brief-origin`)
        .then((result) => result.status()),
    ).toBe(404);
    const graph = graphSchema.parse(
      await response(page.request.get(projectApi + "/graph"), 200),
    );
    expect(graph.edges).toHaveLength(4);
    const audit = auditPageSchema.parse(
      await response(
        page.request.get(
          `${api}/audit?eventId=${applied.receipt!.effectEventId}`,
        ),
        200,
      ),
    );
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      action: "proposal.plan_created",
      proposalId,
      receiptId: receipt,
    });
    const [counts] = await admin`
      SELECT (SELECT count(*)::int FROM public.executions WHERE proposal_id = ${proposalId}) AS executions,
        (SELECT count(*)::int FROM public.audit_events WHERE target_id = ${proposalId} AND action = 'proposal.plan_created') AS effects
    `;
    expect(counts).toEqual({ executions: 1, effects: 1 });

    const doc = await response<{ id: string }>(
      post(projectApi + "/documents", {
        action: "create",
        title: "Manual rollout",
        content,
      }),
      200,
    );
    await response(
      page.request.patch(`${projectApi}/documents/${doc.id}`, {
        headers,
        data: {
          action: "save",
          mutationId: randomUUID(),
          expectedVersion: 1,
          title: "Latest rollout notes",
          content: "Changed after the brief source.",
        },
      }),
      200,
    );
    await page.goto(`${base}/documents/${doc.id}/revisions/1`);
    await page.getByRole("button", { name: "Plan from this revision" }).click();
    await expect(page).toHaveURL(/briefs\/[a-f0-9-]+$/);
    const manualId = new URL(page.url()).pathname.split("/").at(-1)!;
    const manualApi = `${projectApi}/briefs/${manualId}`;
    const reused = await response<{ id: string }>(
      post(projectApi + "/briefs", { documentId: doc.id, sourceRevision: 1 }),
      202,
    );
    expect(reused.id).toBe(manualId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(
        page.getByText(`Extraction attempt ${attempt} of 3`),
      ).toBeVisible();
      await expect(
        page.getByText("The model timed out. The brief is saved."),
      ).toBeVisible();
      if (attempt < 3)
        await page.getByRole("button", { name: "Retry extraction" }).click();
    }
    const capped = await readJob(manualApi);
    expect(capped).toMatchObject({
      content,
      documentId: doc.id,
      sourceRevision: 1,
    });
    await response(
      post(manualApi + "/retry", { expectedVersion: capped.version }),
      409,
    );
    await expect(
      page.getByRole("button", { name: "Retry extraction" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Plan manually" }).click();
    await page.getByLabel("Task title").fill("Write rollout checklist");
    await page.getByRole("button", { name: "Save plan draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Plan from Manual rollout" }),
    ).toBeVisible();
    expect((await readWork()).items).toHaveLength(5);
    expect(calls.get("Manual rollout")).toBe(3);
  } finally {
    await Promise.all([
      leadContext.close(),
      outsideContext.close(),
      runtime.end(),
      admin.end(),
      extractions.close(),
      approvals.close(),
      stopOidc(),
    ]);
    redis.disconnect();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
