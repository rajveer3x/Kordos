import { randomUUID } from "node:crypto";
import {
  auditPageSchema,
  graphSchema,
  inboxHomeSchema,
  projectSchema,
  proposalDetailSchema,
  reviewResponseSchema,
  workFieldsSchema,
  workHistorySchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

function account(name: string) {
  return {
    name,
    email: `activity-${randomUUID()}@example.test`,
    email_verified: true,
  };
}

async function checked(response: Promise<APIResponse>, status = 200) {
  const received = await response;
  const body = await received.json();
  expect(received.status(), JSON.stringify(body)).toBe(status);
  return body;
}

test("Home, project activity and an approved receipt share authorized work and preserve mobile navigation", async ({
  browser,
  baseURL,
}, info) => {
  if (!baseURL) throw new Error("Set the browser origin for this test.");
  const lead = account("Asha");
  const contributor = account("Remy");
  const viewer = account("Noor");
  const stopFixture = await startOidcFixture(
    { lead, contributor, viewer },
    baseURL,
  );
  const contexts = await Promise.all(
    [lead, contributor, viewer].map(() => browser.newContext({ baseURL })),
  );
  const [page, author, reader] = (await Promise.all(
    contexts.map((context) => context.newPage()),
  )) as [Page, Page, Page];
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
  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(author, contributor, "/workspace"),
      signIn(reader, viewer, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Activity studio");
    const ui = `/w/${workspace}`;
    const api = `/api/workspaces/${workspace}`;
    const {
      identity: { id: leadId },
    } = await checked(page.request.get("/api/session"));
    async function invite(from: Page, email: string, role: string) {
      const { token } = await checked(
        post(`${api}/invitations`, { email, role }),
        201,
      );
      await checked(post("/api/invitations/accept", { token }, from));
      const { identity } = await checked(from.request.get("/api/session"));
      return identity.id as string;
    }
    const authorId = await invite(author, contributor.email, "contributor");
    await invite(reader, viewer.email, "viewer");

    async function project(
      name: string,
      visibility: "workspace" | "restricted",
    ) {
      return (
        await checked(
          post(`${api}/projects`, {
            name,
            visibility,
            timeZone: "Asia/Kolkata",
            workdays: [1, 2, 3, 4, 5],
            nonworkingDates: [],
            description: null,
          }),
          201,
        )
      ).id as string;
    }
    const projectId = await project("Checkout release", "workspace");
    const privateId = await project("Private launch experiment", "restricted");
    const endpoint = `${api}/projects/${projectId}`;
    const base = `${ui}/projects/${projectId}`;
    const activity = `${base}/activity`;
    await checked(
      patch(`${endpoint}/members/${authorId}`, {
        role: "contributor",
        expectedVersion: null,
      }),
    );
    const graph = graphSchema.parse(
      await checked(page.request.get(`${endpoint}/graph`)),
    );
    const fields = workFieldsSchema.parse({
      kind: "task",
      title: "Finish checkout handoff",
      description: null,
      ownerId: leadId,
      status: "ready",
      estimateDays: 1,
      deadline: graph.asOf,
      commitment: null,
      blockerOwnerId: null,
      blockerReason: null,
      blockerResolution: null,
    });
    const { id: taskId } = await checked(post(`${endpoint}/work`, fields), 201);
    const { id: privateWork } = await checked(
      post(`${api}/projects/${privateId}/work`, {
        ...fields,
        title: "Restricted rollout scope",
      }),
      201,
    );
    const { id: mention } = await checked(
      post(
        `${endpoint}/discussions/task/${taskId}`,
        {
          action: "post",
          body: "Please review the final handoff.",
          mentionIds: [leadId],
          parentId: null,
        },
        author,
      ),
    );
    const evidence =
      "The checkout team can proceed with the documented rollout.";
    const { id: doc } = await checked(
      post(`${endpoint}/documents`, {
        action: "create",
        title: "Handoff evidence",
        content: evidence,
      }),
    );
    const { id: decision } = await checked(
      post(`${endpoint}/decisions`, {
        action: "draft",
        question: "Use the reviewed rollout?",
        conclusion: "Proceed with the documented rollout.",
        accountableId: leadId,
        effectiveDate: graph.asOf,
        supersedesId: null,
        evidence: [
          {
            kind: "document",
            projectId,
            id: doc,
            anchor: { revision: 1, start: 0, end: evidence.length },
          },
        ],
      }),
    );
    const { id: proposalId } = await checked(
      post(
        `${endpoint}/proposals`,
        {
          workId: taskId,
          targetVersion: 1,
          evidence: [],
          command: {
            kind: "work.edit",
            values: { ...fields, title: "Ship checkout handoff" },
          },
        },
        author,
      ),
      201,
    );
    const proposal = async () =>
      proposalDetailSchema.parse(
        await checked(page.request.get(`${api}/proposals/${proposalId}`)),
      );
    const draft = await proposal();
    const home = async (from: Page, project?: string) =>
      inboxHomeSchema.parse(
        await checked(
          from.request.get(
            `${api}/home${project ? `?projectId=${project}` : ""}`,
          ),
        ),
      );
    const audit = async (from: Page, filter: Record<string, string> = {}) =>
      auditPageSchema.parse(
        await checked(
          from.request.get(
            `${api}/audit?${new URLSearchParams({ projectId, ...filter })}`,
          ),
        ),
      );

    await test.step("Show only authorized priorities and activity", async () => {
      expect(
        (await audit(reader)).items.map(({ action }) => action),
      ).not.toContain("proposal.drafted");
      expect((await audit(reader, { type: "decision" })).items).toEqual([]);
      expect((await home(page, projectId)).decisions).toMatchObject([
        { id: decision, confirmedAt: null },
      ]);
      expect((await home(reader, projectId)).decisions).toEqual([]);
      await checked(
        post(
          `${api}/proposals/${proposalId}/submit`,
          {
            expectedVersion: draft.version,
            revision: draft.revision,
          },
          author,
        ),
      );
      await checked(
        patch(`${endpoint}/decisions/${decision}`, {
          action: "confirm",
          expectedVersion: 1,
        }),
      );
      await expect
        .poll(async () =>
          (await home(page)).mentions.map(({ subjectId }) => subjectId),
        )
        .toContain(mention);
      expect(
        (await home(page, projectId)).due.map(({ subjectId }) => subjectId),
      ).toEqual([taskId]);
      expect(
        (await home(page)).due.map(({ subjectId }) => subjectId),
      ).toContain(privateWork);
      expect((await home(reader)).pendingCount).toBe(0);
      expect((await home(reader)).due).toEqual([]);
      expect((await home(reader)).decisions.map(({ id }) => id)).toContain(
        decision,
      );
      await checked(
        reader.request.get(`${api}/home?projectId=${privateId}`),
        404,
      );
      expect((await audit(reader, { projectId: privateId })).items).toEqual([]);
      expect((await audit(reader, { source: "github" })).items).toEqual([]);

      await page.goto(`${ui}/workspace`);
      const reviews = page.getByRole("region", { name: "Pending reviews (1)" });
      await expect(
        reviews.getByRole("link", { name: fields.title }),
      ).toHaveAttribute("href", `${ui}/reviews/${proposalId}?revision=1`);
      await expect(
        page
          .getByRole("region", { name: "Decisions" })
          .getByRole("link", { name: "Use the reviewed rollout?" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Unread mentions" }).getByRole("link"),
      ).toHaveAttribute("href", new RegExp(mention));
      await page.goto(base);
      await expect(
        page.getByRole("region", { name: "Pending reviews (1)" }),
      ).toBeVisible();
      await reader.goto(base);
      await expect(
        reader.getByRole("region", { name: /Pending reviews/ }),
      ).toHaveCount(0);
      await reader.goto(activity);
      await expect(
        reader.getByRole("heading", { name: "Activity history" }),
      ).toBeVisible();
      await expect(
        reader.getByText("Proposal submitted", { exact: true }),
      ).toBeVisible();
      await expect(
        reader.getByText("Restricted rollout scope", { exact: false }),
      ).toHaveCount(0);
    });

    const current = await proposal();
    const receipt = reviewResponseSchema.parse(
      await checked(
        post(`${api}/proposals/${proposalId}/approve`, {
          revision: current.revision,
          expectedVersion: current.version,
        }),
        202,
      ),
    );
    await expect.poll(async () => (await proposal()).status).toBe("applied");
    const result = (await proposal()).receipt!;
    const eventId = result.effectEventId!;
    await test.step("Reconcile the same approved action across Home, work history and the receipt", async () => {
      expect(result.id).toBe(receipt.receiptId);
      expect((await home(page)).pendingCount).toBe(0);
      expect((await home(page)).due).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subjectId: taskId,
            title: "Ship checkout handoff",
          }),
        ]),
      );
      const workHistory = workHistorySchema.parse(
        await checked(page.request.get(`${endpoint}/work/${taskId}/history`)),
      );
      expect(workHistory.items[0]).toMatchObject({
        id: eventId,
        action: "work.edited",
        after: { title: "Ship checkout handoff", version: 2 },
      });
      expect((await audit(page, { eventId })).items).toEqual([
        expect.objectContaining({
          id: eventId,
          workId: taskId,
          proposalId,
          receiptId: result.id,
          type: "work",
          source: "workspace",
        }),
      ]);
      expect((await audit(page, { eventId: result.auditId })).items).toEqual([
        expect.objectContaining({ proposalId, receiptId: result.id }),
      ]);
      await page.goto(`${ui}/workspace`);
      await expect(
        page.getByRole("region", { name: "Pending reviews (0)" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: "Due work" })
          .getByRole("link", { name: "Ship checkout handoff" }),
      ).toBeVisible();
    });

    await test.step("Keep filters, cursor and the selected event when leaving mobile activity", async () => {
      for (let index = 0; index < 41; index++) {
        await checked(
          post(`${endpoint}/work`, {
            ...fields,
            ownerId: null,
            deadline: null,
            title: `Fixture note ${index}`,
          }),
          201,
        );
      }
      const filter = { actorId: leadId, source: "workspace", type: "work" };
      const newest = await audit(page, filter);
      expect(newest.items).toHaveLength(40);
      expect(newest.nextCursor).toBeTruthy();
      const older = await audit(page, {
        ...filter,
        cursor: newest.nextCursor!,
      });
      expect(older.items.map(({ id }) => id)).toContain(eventId);
      const firstIds = new Set(newest.items.map(({ id }) => id));
      expect(older.items.some(({ id }) => firstIds.has(id))).toBe(false);
      expect(
        (
          await audit(page, {
            ...filter,
            actorId: authorId,
            cursor: newest.nextCursor!,
          })
        ).items,
      ).toEqual([]);

      await page.setViewportSize({ width: 390, height: 830 });
      await page.goto(activity);
      await page.getByLabel("Actor ID").fill(leadId);
      await page
        .getByLabel("Source", { exact: true })
        .selectOption("workspace");
      await page.getByLabel("Type", { exact: true }).selectOption("work");
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await page.getByRole("button", { name: "Older events" }).click();
      await page
        .getByRole("link", { name: "Open event: Agent work item edited" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Selected event" }),
      ).toBeFocused();
      const selected = page.locator(".selected-activity");
      await expect(selected.getByText(`Receipt ${result.id}`)).toBeVisible();
      const original = page.url();
      expect(new URL(original).searchParams.get("selected")).toBe(eventId);
      expect(new URL(original).searchParams.get("cursor")).toBe(
        newest.nextCursor,
      );
      await selected.getByRole("link", { name: "Open work item" }).click();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("heading", { name: "Ship checkout handoff" }),
      ).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Back", exact: true })
        .click();
      await expect(page).toHaveURL(original);
      await expect(page.getByLabel("Type", { exact: true })).toHaveValue(
        "work",
      );
      await expect(selected.getByText(`Receipt ${result.id}`)).toBeVisible();
      await selected.getByRole("link", { name: "Review revision 1" }).click();
      await expect(
        page.getByRole("heading", { name: "Approval receipt" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Back to activity" }).click();
      await expect(page).toHaveURL(original);
      await expect(selected.getByText(`Receipt ${result.id}`)).toBeVisible();

      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(
          page.getByRole("heading", { name: "Selected event" }),
        ).toBeVisible();
        expect(
          await page.locator("body").evaluate((body) => body.scrollWidth),
        ).toBeLessThanOrEqual(width);
        if (width === 1440 || width === 390) {
          await selected.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`activity-${width}.png`),
          });
        }
      }
    });

    await test.step("Archive project priorities and keep authorized history", async () => {
      const current = projectSchema.parse(
        await checked(page.request.get(endpoint)),
      );
      await checked(
        patch(endpoint, {
          action: "archive",
          expectedVersion: current.version,
        }),
      );
      expect((await home(page, projectId)).due).toEqual([]);
      expect((await home(page, projectId)).decisions).toEqual([]);
      expect((await home(page)).mentions).toEqual([]);
      expect(
        (await audit(reader, { eventId })).items.map(({ id }) => id),
      ).toEqual([eventId]);
      expect(
        (await home(page)).due.map(({ subjectId }) => subjectId),
      ).toContain(privateWork);
    });
    await test.step("Remove a restricted project's history on revocation and isolate a workspace switch", async () => {
      const privateMember = `${api}/projects/${privateId}/members/${authorId}`;
      await checked(
        patch(privateMember, { role: "contributor", expectedVersion: null }),
      );
      expect(
        (await audit(author, { projectId: privateId })).items.map(
          ({ targetId }) => targetId,
        ),
      ).toContain(privateWork);
      await checked(patch(privateMember, { role: null, expectedVersion: 1 }));
      expect((await audit(author, { projectId: privateId })).items).toEqual([]);
      await checked(
        author.request.get(`${api}/home?projectId=${privateId}`),
        404,
      );

      const neighbor = randomUUID();
      await checked(
        post("/api/workspaces", {
          id: neighbor,
          name: "Neighbor studio",
          timeZone: "UTC",
        }),
        201,
      );
      await page.goto(`${ui}/workspace`);
      await expect(
        page
          .getByRole("region", { name: "Due work" })
          .getByRole("link", { name: "Restricted rollout scope" }),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: /Switch workspace, current workspace Activity studio/,
        })
        .click();
      await page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("link", { name: /Neighbor studio/ })
        .click();
      await expect(page).toHaveURL(`/w/${neighbor}/workspace`);
      await expect(
        page.getByRole("region", { name: "Due work" }),
      ).toContainText("You have no work due");
      await expect(
        page.getByRole("link", { name: "Restricted rollout scope" }),
      ).toHaveCount(0);
    });
  } finally {
    await Promise.all([
      ...contexts.map((context) => context.close()),
      stopFixture(),
    ]);
  }
});
