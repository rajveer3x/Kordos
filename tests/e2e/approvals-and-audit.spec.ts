import { randomUUID } from "node:crypto";
import {
  approvalQueue,
  auditPageSchema,
  proposalDetailSchema,
  reviewResponseSchema,
  workFieldsSchema,
  workItemSchema,
  type ProposalDetail,
} from "@kordos/contracts";
import { setDatabaseScope } from "@kordos/db";
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

test("reviewed work applies once and audit history preserves the evidence boundary", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  if (!baseURL || !process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error(
      "Set the browser origin, runtime database URL and Redis URL.",
    );
  }
  const lead = account("Asha");
  const reviewer = account("Eli");
  const requester = account("Sam");
  const viewer = account("Noor");
  const stopProvider = await startOidcFixture(
    { lead, reviewer, requester, viewer },
    baseURL,
  );
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const queue = new Queue(approvalQueue, { connection: redis });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ baseURL })),
  );
  const [leadPage, reviewerPage, requesterPage, viewerPage] =
    (await Promise.all(contexts.map((context) => context.newPage()))) as [
      Page,
      Page,
      Page,
      Page,
    ];
  const headers = { Origin: baseURL };
  const secret = "Confidential pilot capacity";
  const evidenceTitle = "Private pilot notes";

  async function response<T>(result: Promise<APIResponse>, expected: number) {
    const value = await result;
    const body = await value.json();
    expect(value.status(), JSON.stringify(body)).toBe(expected);
    return body as T;
  }
  const post = (page: Page, path: string, body: object) =>
    page.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...body },
    });
  const patch = (page: Page, path: string, body: object) =>
    page.request.patch(path, {
      headers,
      data: { mutationId: randomUUID(), ...body },
    });
  const idFrom = (result: Promise<APIResponse>, expected = 201) =>
    response<{ id: string }>(result, expected).then(({ id }) => id);

  try {
    await Promise.all([
      signIn(leadPage, lead, "/workspace"),
      signIn(reviewerPage, reviewer, "/workspace"),
      signIn(requesterPage, requester, "/workspace"),
      signIn(viewerPage, viewer, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(leadPage, "Review Studio");
    const ui = `/w/${workspace}`;
    const api = `/api/workspaces/${workspace}`;
    async function invite(page: Page, user: typeof lead, role: string) {
      const { token } = await response<{ token: string }>(
        post(leadPage, api + "/invitations", { email: user.email, role }),
        201,
      );
      await response(post(page, "/api/invitations/accept", { token }), 200);
      const { identity } = await response<{ identity: { id: string } }>(
        page.request.get("/api/session"),
        200,
      );
      return identity.id;
    }
    const reviewerId = await invite(reviewerPage, reviewer, "contributor");
    const requesterId = await invite(requesterPage, requester, "contributor");
    const viewerId = await invite(viewerPage, viewer, "viewer");
    const project = (name: string, visibility: string) =>
      idFrom(
        post(leadPage, api + "/projects", {
          name,
          visibility,
          timeZone: "Asia/Kolkata",
          workdays: [1, 2, 3, 4, 5],
          nonworkingDates: [],
          description: null,
        }),
      );
    const destination = await project("Shared rollout", "workspace");
    const source = await project("Restricted pilot", "restricted");
    const workApi = `${api}/projects/${destination}/work`;
    const proposals = api + "/proposals";
    async function member(
      projectId: string,
      user: string,
      role: string | null,
      expectedVersion: number | null = null,
    ) {
      await response(
        patch(leadPage, `${api}/projects/${projectId}/members/${user}`, {
          role,
          expectedVersion,
        }),
        200,
      );
    }
    await member(destination, reviewerId, "lead");
    await member(destination, requesterId, "contributor");
    await member(source, reviewerId, "contributor");
    await member(source, requesterId, "contributor");

    const documentId = await idFrom(
      post(leadPage, `${api}/projects/${source}/documents`, {
        action: "create",
        title: evidenceTitle,
        content: secret,
      }),
      200,
    );
    const evidence = {
      kind: "document",
      projectId: source,
      id: documentId,
      anchor: { revision: 1, start: 0, end: secret.length },
    };
    const sourceLink = `${ui}/projects/${source}/documents/evidence/document/${documentId}?revision=1&start=0&end=${secret.length}`;
    const initial = {
      title: "Prepare pilot deployment",
      description: null,
      kind: "task",
      status: "ready",
      ownerId: requesterId,
      estimateDays: 2,
      deadline: "2026-12-01",
      commitment: null,
      blockerReason: null,
      blockerOwnerId: null,
      blockerResolution: null,
    };
    const workId = await idFrom(post(leadPage, workApi, initial));
    const work = workApi + "/" + workId;
    const workLink = `${ui}/projects/${destination}/work/${workId}`;
    const current = async () =>
      workItemSchema.parse(await response(leadPage.request.get(work), 200));
    const detail = async (id: string, page = leadPage, revision?: number) =>
      proposalDetailSchema.parse(
        await response(
          page.request.get(
            `${proposals}/${id}${revision ? "?revision=" + revision : ""}`,
          ),
          200,
        ),
      );
    const precondition = (proposal: ProposalDetail) => ({
      revision: proposal.revision,
      expectedVersion: proposal.version,
    });
    async function draft(
      title: string,
      withEvidence = false,
      expiresAt?: string,
    ) {
      const head = await current();
      return idFrom(
        post(requesterPage, `${api}/projects/${destination}/proposals`, {
          workId,
          targetVersion: head.version,
          command: {
            kind: "work.edit",
            values: { ...workFieldsSchema.parse(head), title },
          },
          evidence: withEvidence ? [evidence] : [],
          expiresAt,
        }),
      );
    }
    async function submit(id: string) {
      await response(
        post(
          requesterPage,
          `${proposals}/${id}/submit`,
          precondition(await detail(id)),
        ),
        200,
      );
      return detail(id);
    }
    const approve = (id: string, page: Page, input: object) =>
      response(post(page, `${proposals}/${id}/approve`, input), 202).then(
        (result) => reviewResponseSchema.parse(result),
      );
    const outcome = async (id: string, status: string) => {
      await expect.poll(async () => (await detail(id)).status).toBe(status);
      return detail(id);
    };

    await response(
      patch(leadPage, work, {
        ...initial,
        title: "Manually scheduled pilot",
        action: "edit",
        expectedVersion: 1,
      }),
      200,
    );
    const rejected = await draft("Rejected pilot wording", true);
    const rejecting = await submit(rejected);
    await response(
      post(
        requesterPage,
        `${proposals}/${rejected}/approve`,
        precondition(rejecting),
      ),
      403,
    );
    await reviewerPage.goto(`${ui}/reviews/${rejected}`);
    await reviewerPage
      .getByRole("button", { name: "Reject", exact: true })
      .click();
    await reviewerPage
      .getByRole("textbox", { name: "Reason for rejection" })
      .fill("Keep the agreed wording.");
    await reviewerPage
      .getByRole("button", { name: "Confirm rejection" })
      .click();
    await expect(
      reviewerPage.getByText("Rejected", { exact: true }),
    ).toBeVisible();
    expect((await detail(rejected, viewerPage)).reason).toBeNull();

    await requesterPage.goto(workLink);
    await requesterPage.getByRole("button", { name: "Propose change" }).click();
    await requesterPage
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Ship the pilot");
    await requesterPage
      .getByRole("textbox", { name: "Evidence links" })
      .fill(sourceLink);
    await requesterPage
      .getByRole("button", { name: "Save proposal draft" })
      .click();
    await expect(requesterPage).toHaveURL(
      new RegExp(ui + "/reviews/[0-9a-f-]+$"),
    );
    const submittedId = new URL(requesterPage.url()).pathname
      .split("/")
      .at(-1)!;
    await requesterPage
      .getByRole("button", { name: "Submit for review" })
      .click();
    await expect(
      requesterPage.getByText("Awaiting review", { exact: true }),
    ).toBeVisible();
    const pending = await detail(submittedId);
    const redacted = await detail(submittedId, viewerPage);
    expect(redacted.before).toBeNull();
    expect(redacted.after).toBeNull();
    expect(redacted.evidenceRestricted).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(documentId);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    await reviewerPage.goto(`${ui}/reviews`);
    await reviewerPage
      .getByRole("button", { name: "Awaiting review (1)" })
      .click();
    const pendingReview = reviewerPage.getByRole("link", {
      name: "Edit task · Manually scheduled pilot",
    });
    await expect(pendingReview).toHaveCount(1);
    await pendingReview.click();
    await expect(reviewerPage.getByText(secret, { exact: true })).toBeVisible();
    await expect(
      reviewerPage.getByText("Ship the pilot", { exact: true }),
    ).toBeVisible();
    for (const width of [1440, 1024, 390, 320]) {
      await reviewerPage.setViewportSize({ width, height: 900 });
      expect(
        await reviewerPage.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }

    const approval = { ...precondition(pending), mutationId: randomUUID() };
    const [first, second] = await Promise.all([
      approve(submittedId, leadPage, approval),
      approve(submittedId, reviewerPage, precondition(pending)),
    ]);
    expect(first.receiptId).toBeTruthy();
    expect(second.receiptId).toBe(first.receiptId);
    const applied = await outcome(submittedId, "applied");
    expect(applied.receipt?.id).toBe(first.receiptId);
    expect((await approve(submittedId, leadPage, approval)).receiptId).toBe(
      first.receiptId,
    );
    expect(await current()).toMatchObject({
      title: "Ship the pilot",
      version: 3,
    });
    await queue.add(
      "apply",
      { id: first.receiptId },
      { jobId: first.receiptId, removeOnComplete: true },
    );
    await expect
      .poll(() => queue.getJobState(first.receiptId!))
      .toBe("unknown");
    expect((await current()).version).toBe(3);

    await leadPage.goto(`${ui}/audit?targetId=${workId}`);
    await expect(
      leadPage.getByText("Manual work item edited", { exact: true }),
    ).toBeVisible();
    await expect(
      leadPage.getByText("Proposal rejected", { exact: true }),
    ).toBeVisible();
    await expect(
      leadPage.getByText("Agent work item edited", { exact: true }),
    ).toBeVisible();
    const effect = leadPage
      .locator("li")
      .filter({ hasText: "Agent work item edited" });
    await effect.getByText("Field changes").click();
    await expect(
      effect.getByText("Manually scheduled pilot", { exact: true }),
    ).toBeVisible();
    await effect.getByRole("link", { name: "Review revision 1" }).click();
    await expect(
      leadPage.getByRole("heading", { name: "Approval receipt" }),
    ).toBeVisible();
    await leadPage
      .getByRole("link", { name: "Open applied work edit" })
      .click();
    await expect(
      leadPage.getByText("Agent work item edited", { exact: true }),
    ).toBeVisible();
    await leadPage.setViewportSize({ width: 320, height: 900 });
    expect(
      await leadPage.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    expect(
      auditPageSchema.parse(
        await response(
          viewerPage.request.get(`${api}/audit?projectId=${source}`),
          200,
        ),
      ).items,
    ).toEqual([]);

    await queue.pause();
    const superseded = await draft("Old approved wording");
    const oldApproval = await approve(
      superseded,
      leadPage,
      precondition(await submit(superseded)),
    );
    const old = await detail(superseded);
    const oldTarget = await current();
    await response(
      patch(leadPage, `${proposals}/${superseded}`, {
        ...precondition(old),
        targetVersion: oldTarget.version,
        command: {
          kind: "work.edit",
          values: {
            ...workFieldsSchema.parse(oldTarget),
            title: "Revised wording",
          },
        },
        evidence: [],
      }),
      200,
    );
    expect(await detail(superseded, leadPage, 1)).toMatchObject({
      status: "stale",
      after: { title: "Old approved wording" },
      receipt: { id: oldApproval.receiptId, issue: "superseded" },
    });
    expect(await detail(superseded)).toMatchObject({
      revision: 2,
      status: "draft",
      receipt: null,
    });

    const changedTarget = await draft("Apply after target change");
    const claimed = await approve(
      changedTarget,
      leadPage,
      precondition(await submit(changedTarget)),
    );
    await runtime`SELECT kordos_reviews.run(${claimed.receiptId!}, 'claim')`;
    expect((await detail(changedTarget)).status).toBe("applying");
    await response(
      patch(leadPage, work, {
        ...initial,
        title: "Latest manual edit",
        action: "edit",
        expectedVersion: 3,
      }),
      200,
    );
    await queue.resume();
    expect((await outcome(changedTarget, "stale")).receipt?.issue).toBe(
      "target_changed",
    );

    await queue.pause();
    const revokedSource = await draft("Apply after evidence loss", true);
    await approve(
      revokedSource,
      reviewerPage,
      precondition(await submit(revokedSource)),
    );
    await member(source, reviewerId, null, 1);
    expect((await detail(revokedSource, reviewerPage)).evidence).toEqual([]);
    await queue.resume();
    expect((await outcome(revokedSource, "stale")).receipt?.issue).toBe(
      "evidence_changed",
    );

    await queue.pause();
    const revokedReviewer = await draft("Apply after reviewer revocation");
    await approve(
      revokedReviewer,
      reviewerPage,
      precondition(await submit(revokedReviewer)),
    );
    await member(destination, reviewerId, null, 1);
    await member(destination, reviewerId, "lead");
    await queue.resume();
    expect((await outcome(revokedReviewer, "stale")).receipt?.issue).toBe(
      "access_changed",
    );
    expect(await current()).toMatchObject({
      title: "Latest manual edit",
      version: 4,
    });

    await leadPage.goto(`${ui}/reviews/${changedTarget}`);
    await expect(
      leadPage.getByText("The work item changed after review.", {
        exact: false,
      }),
    ).toBeVisible();
    await leadPage
      .getByRole("button", { name: "Review latest changes" })
      .click();
    await leadPage
      .getByRole("button", { name: "Keep proposed edits on latest version" })
      .click();
    await expect(
      leadPage.getByRole("textbox", { name: "Title", exact: true }),
    ).toHaveValue("Apply after target change");
    await leadPage.getByRole("button", { name: "Save proposal draft" }).click();
    await expect(leadPage.getByText("Draft", { exact: true })).toBeVisible();
    expect(await detail(changedTarget)).toMatchObject({
      revision: 2,
      targetVersion: 4,
      receipt: null,
    });

    const editRequest = await draft("Unclear wording");
    await response(
      post(leadPage, `${proposals}/${editRequest}/request-edit`, {
        ...precondition(await submit(editRequest)),
        reason: "Specify a date.",
      }),
      200,
    );
    expect(await detail(editRequest)).toMatchObject({
      status: "draft",
      reason: "Specify a date.",
      canSubmit: false,
    });

    await queue.pause();
    const expiry = Date.now() + 4500;
    const expired = await draft(
      "Apply before expiry",
      false,
      new Date(expiry).toISOString(),
    );
    await approve(expired, leadPage, precondition(await submit(expired)));
    await expect.poll(() => Date.now()).toBeGreaterThan(expiry);
    await queue.resume();
    expect((await outcome(expired, "expired")).receipt?.issue).toBe("expired");

    await queue.pause();
    const head = await current();
    const invalidOwner = await idFrom(
      post(requesterPage, `${api}/projects/${destination}/proposals`, {
        workId,
        targetVersion: head.version,
        command: {
          kind: "work.edit",
          values: { ...workFieldsSchema.parse(head), ownerId: reviewerId },
        },
        evidence: [],
      }),
    );
    await approve(
      invalidOwner,
      leadPage,
      precondition(await submit(invalidOwner)),
    );
    await member(destination, reviewerId, null, 3);
    await queue.resume();
    expect((await outcome(invalidOwner, "failed")).receipt?.issue).toBe(
      "invalid_change",
    );
    expect((await current()).version).toBe(4);

    await runtime.begin(async (sql) => {
      await setDatabaseScope(sql, viewerId, workspace);
      const [audit] =
        await sql`SELECT count(*)::int AS count FROM public.audit_events WHERE project_id = ${source}`;
      expect(audit?.count).toBe(0);
    });
    for (const table of ["audit_events", "proposal_revisions", "executions"]) {
      await expect(
        runtime`UPDATE public.${runtime(table)} SET workspace_id = workspace_id WHERE false`,
      ).rejects.toMatchObject({ code: "42501" });
    }
  } finally {
    await queue.resume();
    await Promise.all(contexts.map((context) => context.close()));
    await queue.close();
    redis.disconnect();
    await runtime.end();
    await stopProvider();
  }
});
