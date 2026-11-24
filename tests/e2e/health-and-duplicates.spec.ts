import { randomUUID } from "node:crypto";
import {
  approvalQueue,
  duplicateReviewSchema,
  graphSchema,
  proposalDetailSchema,
  weeklyReportsSchema,
  workFieldsSchema,
  workItemSchema,
  type WorkFields,
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
    email: `health-${randomUUID()}@example.test`,
    email_verified: true,
  };
}

function offset(date: string, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

async function result(response: Promise<APIResponse>, status: number) {
  const received = await response;
  const body = await received.json();
  expect(received.status(), JSON.stringify(body)).toBe(status);
  return body;
}

test("weekly evidence stays private and duplicate approval preserves task history and graph integrity", async ({
  browser,
  baseURL,
}, testInfo) => {
  if (
    !baseURL ||
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.DATABASE_URL ||
    !process.env.REDIS_URL
  ) {
    throw new Error(
      "Set the local application, runtime, migration and Redis test URLs.",
    );
  }
  const lead = account("Asha");
  const contributor = account("Remy");
  const stopFixture = await startOidcFixture({ lead, contributor }, baseURL);
  const [leadContext, memberContext] = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  const [page, peer] = await Promise.all([
    leadContext.newPage(),
    memberContext.newPage(),
  ]);
  const owner = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const queue = new Queue(approvalQueue, { connection: redis });
  const headers = { Origin: baseURL };
  const post = (path: string, data: object, from = page) =>
    from.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const patch = (path: string, data: object) =>
    page.request.patch(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const workFields = workFieldsSchema.parse({
    title: "Work item",
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
  });

  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(peer, contributor, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Health studio");
    const api = `/api/workspaces/${workspace}`;
    const ui = `/w/${workspace}`;
    const { token } = await result(
      post(`${api}/invitations`, {
        email: contributor.email,
        role: "contributor",
      }),
      201,
    );
    await result(post("/api/invitations/accept", { token }, peer), 200);
    const { identity } = await result(peer.request.get("/api/session"), 200);
    const timeZone = "Pacific/Kiritimati";
    async function project(
      name: string,
      visibility: "workspace" | "restricted",
    ) {
      return (
        await result(
          post(`${api}/projects`, {
            name,
            visibility,
            timeZone,
            description: null,
            workdays: [1, 2, 3, 4, 5, 6, 7],
            nonworkingDates: [],
          }),
          201,
        )
      ).id as string;
    }
    const projectId = await project("October release", "workspace");
    const evidenceProject = await project(
      "Restricted review notes",
      "restricted",
    );
    const endpoint = `${api}/projects/${projectId}`;
    const projectUrl = `${ui}/projects/${projectId}`;
    const health = `${endpoint}/weekly-health`;
    const evidenceMembership = `${api}/projects/${evidenceProject}/members/${identity.id}`;
    await result(
      patch(`${endpoint}/members/${identity.id}`, {
        role: "contributor",
        expectedVersion: null,
      }),
      200,
    );
    await result(
      patch(evidenceMembership, { role: "contributor", expectedVersion: null }),
      200,
    );
    const graph = async () =>
      graphSchema.parse(
        await result(page.request.get(`${endpoint}/graph`), 200),
      );
    const work = async (title: string, extra: Partial<WorkFields> = {}) =>
      (
        await result(
          post(`${endpoint}/work`, { ...workFields, ...extra, title }),
          201,
        )
      ).id as string;
    const item = async (id: string) =>
      workItemSchema.parse(
        await result(page.request.get(`${endpoint}/work/${id}`), 200),
      );
    async function edge(predecessorId: string, successorId: string) {
      await result(
        post(`${endpoint}/dependencies`, {
          action: "add",
          predecessorId,
          successorId,
          expectedVersion: (await graph()).graphVersion,
        }),
        200,
      );
    }
    const report = async (from: Page, period?: string) =>
      weeklyReportsSchema.parse(
        await result(
          from.request.get(`${health}${period ? `?period=${period}` : ""}`),
          200,
        ),
      ).report;
    const detail = async (id: string) =>
      proposalDetailSchema.parse(
        await result(page.request.get(`${api}/proposals/${id}`), 200),
      );
    const duplicates = (id: string) => `${endpoint}/work/${id}/duplicates`;
    const compare = async (id: string, from = page) =>
      duplicateReviewSchema.parse(
        await result(from.request.get(duplicates(id)), 200),
      );
    async function pair(
      keep: string,
      archive: string,
      action = "consolidate",
      from = page,
    ) {
      const [first, second, schedule] = await Promise.all([
        item(keep),
        item(archive),
        graph(),
      ]);
      return post(
        duplicates(keep),
        {
          action,
          taskVersion: first.version,
          other: { id: archive, version: second.version },
          graphVersion: schedule.graphVersion,
        },
        from,
      );
    }

    await test.step("Publish a cited project-time snapshot and recheck access to a historical review request", async () => {
      const { asOf } = await graph();
      const late = await work("Late API handoff", {
        deadline: offset(asOf, -2),
        blockerReason: "Waiting for credentials",
      });
      const launch = await work("Customer launch", {
        kind: "milestone",
        estimateDays: null,
        commitment: offset(asOf, 7),
      });
      await edge(late, launch);
      const missing = await work("Estimate security review", {
        estimateDays: null,
      });
      const uncertain = await work("Security sign-off", {
        kind: "milestone",
        estimateDays: null,
        commitment: offset(asOf, 7),
      });
      await edge(missing, uncertain);
      await work("Alpha rollout", {
        kind: "milestone",
        estimateDays: null,
        status: "done",
      });

      const privateText = "Restricted allocation evidence";
      const { id: doc } = await result(
        post(`${api}/projects/${evidenceProject}/documents`, {
          action: "create",
          title: "Private allocation",
          content: privateText,
        }),
        200,
      );
      const { id: proposal } = await result(
        post(`${endpoint}/proposals`, {
          workId: late,
          targetVersion: (await item(late)).version,
          command: {
            kind: "work.edit",
            values: {
              ...workFields,
              title: "Late API handoff",
              description: "Allocations reviewed",
            },
          },
          evidence: [
            {
              kind: "document",
              projectId: evidenceProject,
              id: doc,
              anchor: { revision: 1, start: 0, end: privateText.length },
            },
          ],
        }),
        201,
      );
      const review = await detail(proposal);
      await result(
        post(`${api}/proposals/${proposal}/submit`, {
          expectedVersion: review.version,
          revision: review.revision,
        }),
        200,
      );

      // Make an early empty snapshot due again while the real worker is running.
      await owner`UPDATE public.project_weeklies SET generated_at = now() - interval '2 minutes'
        WHERE workspace_id = ${workspace} AND project_id = ${projectId}`;
      await expect
        .poll(
          async () => (await report(peer))?.decisions.map(({ id }) => id) ?? [],
        )
        .toContain(proposal);
      const saved = (await report(peer))!;
      expect(saved.asOf).toBe(asOf);
      expect(saved.timeZone).toBe(timeZone);
      expect(new Date(saved.period).getUTCDay()).toBe(1);
      expect(saved.endExclusive).toBe(offset(saved.period, 7));
      expect(saved.milestones).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: launch,
            health: "on_track",
            slackDays: 6,
          }),
          expect.objectContaining({
            id: uncertain,
            health: "uncertain",
            slackDays: null,
          }),
        ]),
      );
      expect(saved.blockers.map(({ id }) => id)).toContain(late);
      expect(saved.missingEstimates.map(({ id }) => id)).toContain(missing);
      expect(saved.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "work.completed",
            kind: "milestone",
            title: "Alpha rollout",
          }),
        ]),
      );

      const historyPeriod = offset(saved.period, -7);
      await owner`INSERT INTO public.project_weeklies (workspace_id,project_id,period,generated_at,snapshot)
        SELECT workspace_id,project_id,${historyPeriod}::text::date,generated_at - interval '7 days',snapshot
        FROM public.project_weeklies WHERE workspace_id = ${workspace} AND project_id = ${projectId}
          AND period = ${saved.period}::text::date`;
      await peer.goto(`${projectUrl}/weekly-health?period=${historyPeriod}`);
      await expect(
        peer.getByRole("heading", { name: "Weekly health" }),
      ).toBeVisible();
      await expect(peer.getByText("On track", { exact: true })).toBeVisible();
      await expect(peer.getByText("Uncertain", { exact: true })).toBeVisible();
      await expect(
        peer.getByRole("link", { name: "Customer launch" }),
      ).toHaveAttribute("href", `${projectUrl}/work/${launch}`);
      await expect(
        peer.getByRole("link", { name: "Alpha rollout" }),
      ).toHaveAttribute("href", /audit\?eventId=/);
      const decisionUrl = `${ui}/reviews/${proposal}?revision=1`;
      await expect(
        peer
          .getByRole("link", { name: "Late API handoff" })
          .and(peer.locator(`a[href="${decisionUrl}"]`)),
      ).toBeVisible();
      for (const width of [1440, 390]) {
        await peer.setViewportSize({ width, height: 900 });
        await peer.screenshot({
          path: testInfo.outputPath(`weekly-health-${width}.png`),
          fullPage: true,
        });
      }
      await peer.goto(`${ui}/reviews/${proposal}?revision=1`);
      await expect(peer.getByText(privateText, { exact: true })).toBeVisible();

      await result(
        patch(evidenceMembership, { role: null, expectedVersion: 1 }),
        200,
      );
      expect((await report(peer, historyPeriod))?.decisions).toEqual([]);
      expect(
        (await report(page, historyPeriod))?.decisions.map(({ id }) => id),
      ).toContain(proposal);
      await peer.goto(`${projectUrl}/weekly-health?period=${historyPeriod}`);
      await expect(peer.getByText("0 decisions requested")).toBeVisible();
      await expect(peer.getByText(privateText)).toHaveCount(0);
      await result(
        peer.request.get(`${api}/projects/${evidenceProject}/weekly-health`),
        404,
      );
      await result(
        peer.request.get(
          `/api/workspaces/${randomUUID()}/projects/${projectId}/weekly-health`,
        ),
        404,
      );
      await expect(
        runtime`SELECT snapshot FROM public.project_weeklies LIMIT 1`,
      ).rejects.toMatchObject({ code: "42501" });

      for (const width of [1440, 1024, 390, 320]) {
        await peer.setViewportSize({ width, height: 900 });
        expect(
          await peer.locator("body").evaluate((body) => body.scrollWidth),
        ).toBeLessThanOrEqual(width);
      }
    });

    await test.step("Review retrieval, symmetric dismissal and related work", async () => {
      const first = await work("Publish checkout installation guide", {
        description: "Write the installation walkthrough for the checkout SDK.",
      });
      const second = await work("Publish checkout installation guides", {
        description: "Update the installation walkthrough with sample code.",
      });
      await peer.goto(`${projectUrl}/work/${first}`);
      await peer.getByRole("link", { name: "Review similar tasks" }).click();
      const card = peer.locator(".project-health-comparison").filter({
        has: peer.getByRole("heading", {
          name: "Publish checkout installation guides",
          exact: true,
          level: 3,
        }),
      });
      await expect(
        card.getByText("Shared deliverable terms", { exact: false }),
      ).toBeVisible();
      await expect(
        card.getByText("Update the installation walkthrough with sample code."),
      ).toBeVisible();
      await peer.setViewportSize({ width: 390, height: 900 });
      await peer.screenshot({
        path: testInfo.outputPath("duplicate-review-390.png"),
        fullPage: true,
      });
      await peer.setViewportSize({ width: 320, height: 900 });
      expect(
        await peer.locator("body").evaluate((body) => body.scrollWidth),
      ).toBeLessThanOrEqual(320);
      await card.getByRole("button", { name: "Dismiss" }).click();
      await expect(peer.getByText("Suggestion dismissed.")).toBeVisible();
      expect(
        (await compare(second)).candidates.map(({ id }) => id),
      ).not.toContain(first);

      await result(
        patch(`${endpoint}/work/${second}`, {
          ...workFields,
          title: "Publish checkout installation guides",
          description: "Add the installation walkthrough and troubleshooting.",
          action: "edit",
          expectedVersion: (await item(second)).version,
        }),
        200,
      );
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Link as related" }).click();
      await expect(peer.getByText("Tasks linked as related.")).toBeVisible();
      expect((await compare(second)).links).toContainEqual(
        expect.objectContaining({ id: first, relation: "related" }),
      );
    });

    await test.step("Apply one consolidation, keep history and dependency edges, and reject cycles", async () => {
      const keep = await work("Prepare storefront smoke test");
      const archive = await work("Prepare storefront smoke tests", {
        description: "Historical validation notes",
      });
      const discussion = `${endpoint}/discussions/task/${archive}`;
      const originalComment =
        "Reuse the simulated checkout transaction for validation.";
      await result(
        post(discussion, {
          action: "post",
          body: originalComment,
          mentionIds: [],
          parentId: null,
        }),
        200,
      );
      const predecessor = await work("Provision fixture environment");
      const successor = await work("Start release checklist");
      await edge(predecessor, archive);
      await edge(archive, successor);
      await page.goto(`${projectUrl}/duplicates/${keep}`);
      await page.getByText("Propose consolidation", { exact: true }).click();
      await page
        .getByRole("button", {
          name: "Keep Prepare storefront smoke test",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Consolidation plan" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Provision fixture environment" }),
      ).toBeVisible();
      const proposal = new URL(page.url()).pathname.split("/").at(-1)!;
      const review = await detail(proposal);
      const approval = {
        revision: review.revision,
        expectedVersion: review.version,
      };
      await result(
        post(`${api}/proposals/${proposal}/approve`, approval, peer),
        403,
      );
      const [first, repeated] = await Promise.all([
        result(post(`${api}/proposals/${proposal}/approve`, approval), 202),
        result(post(`${api}/proposals/${proposal}/approve`, approval), 202),
      ]);
      expect(first.receiptId).toBe(repeated.receiptId);
      await expect
        .poll(async () => (await detail(proposal)).status)
        .toBe("applied");
      const archived = await item(archive);
      expect(archived).toMatchObject({
        archived: true,
        description: "Historical validation notes",
      });
      expect((await item(keep)).archived).toBe(false);
      expect(
        JSON.stringify(await result(page.request.get(discussion), 200)),
      ).toContain(originalComment);
      const [replay] =
        await runtime`SELECT kordos_reviews.run(${first.receiptId}::uuid,'apply') AS applied`;
      expect(replay?.applied).toBe(false);
      const graphAfter = await graph();
      expect(graphAfter.edges).toEqual(
        expect.arrayContaining([
          { predecessorId: predecessor, successorId: keep },
          { predecessorId: keep, successorId: successor },
        ]),
      );
      const original = await owner`SELECT id FROM public.dependency_edges
        WHERE workspace_id = ${workspace} AND project_id = ${projectId} AND (predecessor_id = ${archive} OR successor_id = ${archive})`;
      expect(original).toHaveLength(2);
      const history = await result(
        page.request.get(`${endpoint}/work/${archive}/history`),
        200,
      );
      expect(
        history.items.map(({ action }: { action: string }) => action),
      ).toEqual(expect.arrayContaining(["work.created", "work.archived"]));
      expect((await compare(archive)).links).toContainEqual(
        expect.objectContaining({ id: keep, relation: "consolidated_into" }),
      );
      await result(
        patch(`${endpoint}/work/${archive}`, {
          action: "restore",
          expectedVersion: archived.version,
        }),
        409,
      );

      const a = await work("Audit receipt formatting");
      const b = await work("Verify sample receipts");
      const c = await work("Audit receipts formatting");
      await edge(a, b);
      await queue.pause();
      try {
        const pending = (await result(pair(a, c), 201)).id;
        const current = await detail(pending);
        await result(
          post(`${api}/proposals/${pending}/approve`, {
            revision: current.revision,
            expectedVersion: current.version,
          }),
          202,
        );
        await edge(b, c);
        await result(pair(a, c), 409);
        await queue.resume();
        await expect
          .poll(async () => (await detail(pending)).receipt?.status)
          .toBe("stale");
        expect((await item(c)).archived).toBe(false);
        expect((await graph()).edges).not.toContainEqual({
          predecessorId: b,
          successorId: a,
        });
      } finally {
        await queue.resume();
      }
    });
  } finally {
    await Promise.all([
      leadContext.close(),
      memberContext.close(),
      owner.end(),
      runtime.end(),
      queue.close(),
      stopFixture(),
    ]);
    redis.disconnect();
  }
});
