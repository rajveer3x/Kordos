import { randomUUID } from "node:crypto";
import {
  approvalQueue,
  auditPageSchema,
  graphSchema,
  proposalDetailSchema,
  proposalPageSchema,
  riskDetailSchema,
  riskPageSchema,
  workItemSchema,
  workFieldsSchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

function account(name: string) {
  return {
    name,
    email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
    email_verified: true,
  };
}
function offset(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

test("delay reports forecast downstream impact, retain evidence history, and replan through approval", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  if (!baseURL || !process.env.DATABASE_URL || !process.env.REDIS_URL)
    throw new Error("Set the browser, database and Redis URLs.");
  const lead = account("Lina");
  const author = account("Nikhil");
  const outsider = account("Chen");
  const stopIssuer = await startOidcFixture(
    { lead, author, outsider },
    baseURL,
  );
  const leadContext = await browser.newContext({ baseURL });
  const authorContext = await browser.newContext({ baseURL });
  const outsideContext = await browser.newContext({ baseURL });
  const [page, peer, outside] = await Promise.all([
    leadContext.newPage(),
    authorContext.newPage(),
    outsideContext.newPage(),
  ]);
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const approvals = new Queue(approvalQueue, { connection: redis });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const headers = { Origin: baseURL };
  let paused = false;

  async function response<T>(
    request: Promise<APIResponse>,
    status = 200,
  ): Promise<T> {
    const received = await request;
    const body = await received.json();
    expect(received.status(), JSON.stringify(body)).toBe(status);
    return body as T;
  }
  const post = (actor: Page, path: string, data: object) =>
    actor.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const savedId = (request: Promise<APIResponse>, status = 200) =>
    response<{ id: string }>(request, status).then(({ id }) => id);

  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(peer, author, "/workspace"),
      signIn(outside, outsider, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Risk Studio");
    const api = `/api/workspaces/${workspace}`;
    for (const [actor, identity] of [
      [peer, author],
      [outside, outsider],
    ] as const) {
      const { token } = await response<{ token: string }>(
        post(page, api + "/invitations", {
          email: identity.email,
          role: "contributor",
        }),
        201,
      );
      await response(post(actor, "/api/invitations/accept", { token }));
    }
    const { identity } = await response<{ identity: { id: string } }>(
      peer.request.get("/api/session"),
    );
    const project = await savedId(
      post(page, api + "/projects", {
        name: "Release readiness",
        description: null,
        visibility: "restricted",
        timeZone: "America/Los_Angeles",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
      }),
      201,
    );
    const endpoint = `${api}/projects/${project}`;
    const base = `/w/${workspace}/projects/${project}`;
    await response(
      page.request.patch(`${endpoint}/members/${identity.id}`, {
        headers,
        data: {
          mutationId: randomUUID(),
          role: "contributor",
          expectedVersion: null,
        },
      }),
    );

    const getGraph = async () =>
      graphSchema.parse(await response(page.request.get(endpoint + "/graph")));
    const start = (await getGraph()).asOf;
    const monday = offset(start, 7 + ((8 - new Date(start).getUTCDay()) % 7));
    const friday = offset(monday, -3);
    const wednesday = offset(monday, 2);
    const work = (
      title: string,
      estimateDays: number | null,
      commitment: string | null = null,
      ownerId: string | null = null,
    ) =>
      savedId(
        post(page, endpoint + "/work", {
          title,
          estimateDays,
          commitment,
          ownerId,
          kind: commitment ? "milestone" : "task",
          description: null,
          status: "ready",
          deadline: null,
          blockerReason: null,
          blockerOwnerId: null,
          blockerResolution: null,
        }),
        201,
      );
    const handoff = await work("API handoff", 1, null, identity.id);
    const qa = await work("QA", 2);
    const launch = await work("Launch", null, monday);
    const authA = await work("Auth", 1, null, identity.id);
    const authB = await work("Auth", 1);
    const copy = await work("Copy edit", 1);
    for (const [predecessorId, successorId] of [
      [handoff, qa],
      [qa, launch],
    ]) {
      await response(
        post(page, endpoint + "/dependencies", {
          action: "add",
          predecessorId,
          successorId,
          expectedVersion: (await getGraph()).graphVersion,
        }),
      );
    }
    const discussion = `${endpoint}/discussions/project/${project}`;
    const writeReport = (text: string, target = discussion) =>
      savedId(
        post(peer, target, {
          action: "post",
          parentId: null,
          mentionIds: [],
          body: text,
        }),
      );
    const editReport = (id: string, version: number, body: string) =>
      response(
        post(peer, discussion, {
          action: "edit",
          commentId: id,
          expectedVersion: version,
          body,
          mentionIds: [],
        }),
      );
    const riskEndpoint = endpoint + "/risks";
    const list = async (history = false) =>
      riskPageSchema.parse(
        await response(
          page.request.get(riskEndpoint + (history ? "?history=true" : "")),
        ),
      );
    const detail = async (id: string) =>
      riskDetailSchema.parse(
        await response(page.request.get(`${riskEndpoint}/${id}`)),
      );
    const proposal = async (id: string) =>
      proposalDetailSchema.parse(
        await response(page.request.get(`${api}/proposals/${id}`)),
      );
    const launchItem = async () =>
      workItemSchema.parse(
        await response(page.request.get(`${endpoint}/work/${launch}`)),
      );
    const approve = (id: string, version: number, revision: number) =>
      post(page, `${api}/proposals/${id}/approve`, {
        expectedVersion: version,
        revision,
      });

    await page.goto(base);
    const ranked = page.getByRole("region", { name: "Schedule risks" });
    await expect(ranked.getByText("No active schedule risks.")).toBeVisible();
    const firstText = `API handoff is delayed until ${friday} due to a test environment issue.`;
    const report = await writeReport(firstText);
    await expect(
      ranked.getByRole("link", { name: "API handoff" }),
    ).toBeVisible();
    const originalId = (await list()).items[0]!.id;
    const original = await detail(originalId);
    expect(original.source.id).toBe(report);
    expect(original.assessment.milestones[0]).toMatchObject({
      commitment: monday,
      forecast: wednesday,
    });
    expect(original.assessment.milestones[0]?.path.map(({ id }) => id)).toEqual(
      [handoff, qa, launch],
    );
    expect((await launchItem()).commitment).toBe(monday);
    expect(
      (await outside.request.get(`${riskEndpoint}/${originalId}`)).status(),
    ).toBe(404);
    await expect(
      runtime`SELECT * FROM public.risk_findings`,
    ).rejects.toMatchObject({ code: "42501" });

    await ranked.getByRole("link", { name: "API handoff" }).click();
    await expect(
      page.getByRole("heading", { name: "Delay report for API handoff" }),
    ).toBeVisible();
    await expect(page.getByRole("blockquote")).toHaveText(firstText);
    await expect(
      page.getByRole("link", { name: "QA", exact: true }),
    ).toBeVisible();
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 880 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
    }
    await page.getByLabel("Review note (optional)").fill("Validating with QA.");
    await page.getByRole("button", { name: "Acknowledge risk" }).click();
    await expect(page.getByText("Acknowledged", { exact: true })).toBeVisible();
    expect((await detail(originalId)).review).toMatchObject({
      reason: "Validating with QA.",
    });
    await expect(
      runtime`SELECT kordos_reviews.run_before_risks(NULL, 'apply')`,
    ).rejects.toMatchObject({ code: "42501" });

    async function submitCurrent() {
      await page
        .getByRole("button", { name: "Submit replan for approval" })
        .click();
      await expect(page).toHaveURL(/\/reviews\/[\da-f-]+$/);
      return new URL(page.url()).pathname.split("/").at(-1)!;
    }
    const firstProposal = await submitCurrent();
    const first = await proposal(firstProposal);
    expect(first.status).toBe("pending");
    expect((await launchItem()).commitment).toBe(monday);
    await editReport(
      report,
      1,
      `API handoff is delayed until ${friday} after the build retry.`,
    );
    await response(approve(firstProposal, first.version, first.revision), 409);
    const pendingQueue = proposalPageSchema.parse(
      await response(page.request.get(`${api}/proposals?status=pending`)),
    );
    expect(pendingQueue.items.map(({ id }) => id)).not.toContain(firstProposal);
    await expect(
      page.getByRole("link", { name: "Review latest risk" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Review latest risk" }).click();
    await expect(page.getByText("Superseded", { exact: true })).toBeVisible();
    await expect(page.getByRole("blockquote")).toHaveText(firstText);
    await page.getByRole("link", { name: "Latest finding" }).click();
    await expect(page.getByRole("blockquote")).toContainText(
      "after the build retry",
    );
    const nextProposal = await submitCurrent();
    const second = await proposal(nextProposal);

    await approvals.pause();
    paused = true;
    await response(approve(nextProposal, second.version, second.revision), 202);
    await editReport(
      report,
      2,
      `API handoff is delayed until ${friday} after the retry and smoke test.`,
    );
    await approvals.resume();
    paused = false;
    await expect
      .poll(async () => (await proposal(nextProposal)).receipt?.issue)
      .toBe("risk_stale");
    expect((await launchItem()).commitment).toBe(monday);
    await expect
      .poll(async () => {
        const item = (await list()).items.find(
          ({ title }) => title === "API handoff",
        );
        return item ? (await detail(item.id)).source.version : null;
      })
      .toBe(3);
    const latest = (await list()).items.find(
      ({ title }) => title === "API handoff",
    )!;
    await page.goto(`${base}/risks/${latest.id}`);
    await expect(page.getByRole("blockquote")).toContainText("smoke test");
    const qaTask = workItemSchema.parse(
      await response(page.request.get(endpoint + "/work/" + qa)),
    );
    await response(
      page.request.patch(endpoint + "/work/" + qa, {
        headers,
        data: {
          ...workFieldsSchema.parse(qaTask),
          description: "Refresh the QA runbook.",
          action: "edit",
          expectedVersion: qaTask.version,
          mutationId: randomUUID(),
        },
      }),
    );
    await expect(
      page.getByText(
        "The project schedule changed. Refresh the forecast before submitting a replan.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh forecast" }).click();
    await expect(
      page.getByRole("button", { name: "Submit replan for approval" }),
    ).toBeVisible();
    const currentId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(currentId).not.toBe(latest.id);
    expect((await detail(currentId)).previousId).toBe(latest.id);
    expect((await detail(currentId)).inputRevision).not.toBe(
      (await detail(latest.id)).inputRevision,
    );
    const finalId = await submitCurrent();
    await page.getByRole("button", { name: "Approve change" }).click();
    await expect(page.getByText("Applied", { exact: true })).toBeVisible();
    expect((await launchItem()).commitment).toBe(wednesday);
    expect((await proposal(finalId)).receipt?.effectEventId).toBeTruthy();

    const auth = await writeReport(`Auth is delayed until ${friday}.`);
    const copyReport = await writeReport(
      `Copy edit is late and will finish on ${friday}.`,
      `${endpoint}/discussions/task/${copy}`,
    );
    await expect
      .poll(async () =>
        (await list(true)).items.some(
          ({ title, severity }) =>
            title === "Copy edit" && severity === "unchanged",
        ),
      )
      .toBe(true);
    const items = (await list()).items;
    expect(items.some(({ title }) => title === "Copy edit")).toBe(false);
    const uncertainId = items.find(
      ({ severity }) => severity === "clarify",
    )!.id;
    const uncertain = await detail(uncertainId);
    expect(uncertain.source.id).toBe(auth);
    expect(uncertain.assessment.candidates.map(({ id }) => id).sort()).toEqual(
      [authA, authB].sort(),
    );
    await response(
      post(page, `${riskEndpoint}/${uncertainId}`, {
        action: "clarify",
        taskId: authA,
        expectedVersion: uncertain.version,
      }),
      403,
    );
    await peer.goto(`${base}/risks/${uncertainId}`);
    await peer.getByLabel("Which task is delayed?").selectOption(authA);
    await peer.getByRole("button", { name: "Confirm delayed task" }).click();
    await expect(
      peer.getByRole("heading", { name: "Delay report for Auth" }),
    ).toBeVisible();
    const confirmedId = new URL(peer.url()).pathname.split("/").at(-1)!;
    expect((await detail(confirmedId)).assessment.task?.id).toBe(authA);
    const unchanged = (await list(true)).items.find(
      ({ title }) => title === "Copy edit",
    )!;
    expect((await detail(unchanged.id)).source.id).toBe(copyReport);
    expect((await detail(unchanged.id)).assessment.milestones).toEqual([]);

    await page.goto(`${base}/risks/${currentId}`);
    await page.getByRole("button", { name: "Resolve risk" }).click();
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    const audit = auditPageSchema.parse(
      await response(page.request.get(`${api}/audit?projectId=${project}`)),
    );
    expect(
      audit.items.some(
        ({ action, actorType }) =>
          action === "risk.severity_changed" && actorType === "service",
      ),
    ).toBe(true);
  } finally {
    if (paused) await approvals.resume();
    await Promise.all([
      leadContext.close(),
      authorContext.close(),
      outsideContext.close(),
      approvals.close(),
      runtime.end(),
      stopIssuer(),
    ]);
    redis.disconnect();
  }
});
