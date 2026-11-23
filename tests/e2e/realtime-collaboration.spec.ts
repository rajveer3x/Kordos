import { randomUUID } from "node:crypto";
import { commentFeedSchema, commentSnapshotSchema } from "@kordos/contracts";
import { setDatabaseScope } from "@kordos/db";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const run = randomUUID();
const lead = {
  name: "Devika",
  email: `devika-${run}@example.test`,
  email_verified: true,
};
const contributor = {
  name: "Kai",
  email: `kai-${run}@example.test`,
  email_verified: true,
};
const outsider = {
  name: "Avery",
  email: `avery-${run}@example.test`,
  email_verified: true,
};

async function joinRoom(page: Page, auth: object) {
  return page.evaluate(
    (payload) =>
      new Promise<string>((resolve, reject) => {
        const url = new URL(
          "/realtime/?EIO=4&transport=websocket",
          location.href,
        );
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url);
        ws.onerror = () => reject(new Error("WebSocket upgrade failed"));
        ws.onmessage = ({ data }: MessageEvent<string>) => {
          if (data.startsWith("0")) ws.send("40" + JSON.stringify(payload));
          if (data.startsWith("40") || data.startsWith("44")) {
            resolve(data);
            ws.close();
          }
        };
      }),
    auth,
  );
}

test("discussion survives overlapping replay, audience revocation and presence expiry", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  if (
    !baseURL ||
    !process.env.DATABASE_URL ||
    !process.env.MIGRATION_DATABASE_URL
  ) {
    throw new Error(
      "Set the browser origin and both database URLs before testing collaboration.",
    );
  }
  const headers = { Origin: baseURL };
  const stopProvider = await startOidcFixture(
    { lead, contributor, outsider },
    baseURL,
  );
  const leadContext = await browser.newContext({ baseURL });
  const contributorContext = await browser.newContext({ baseURL });
  const outsiderContext = await browser.newContext({ baseURL });
  const leadPage = await leadContext.newPage();
  const contributorPage = await contributorContext.newPage();
  const outsiderPage = await outsiderContext.newPage();
  const owner = postgres(process.env.MIGRATION_DATABASE_URL);
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const contributorFrames: string[] = [];
  let contributorWire: WebSocketRoute | undefined;
  let suppressHeartbeat = false;

  try {
    await Promise.all([
      signIn(leadPage, lead, "/workspace"),
      signIn(contributorPage, contributor, "/workspace"),
      signIn(outsiderPage, outsider, "/workspace"),
    ]);
    const workspaceId = await createTestWorkspace(
      leadPage,
      "Collaboration Studio",
    );
    const api = `/api/workspaces/${workspaceId}`;
    for (const [account, context, role] of [
      [contributor, contributorContext, "contributor"],
      [outsider, outsiderContext, "admin"],
    ] as const) {
      const invitation = await leadContext.request.post(`${api}/invitations`, {
        headers,
        data: { email: account.email, role },
      });
      expect(invitation.status()).toBe(201);
      const { token } = await invitation.json();
      expect(
        (
          await context.request.post("/api/invitations/accept", {
            headers,
            data: { token },
          })
        ).status(),
      ).toBe(200);
    }
    const actor = async (page: Page) =>
      (await (await page.request.get("/api/session")).json()).identity
        .id as string;
    const [leadId, contributorId, outsiderId] = await Promise.all([
      actor(leadPage),
      actor(contributorPage),
      actor(outsiderPage),
    ]);
    const project = await leadContext.request.post(`${api}/projects`, {
      headers,
      data: {
        name: "Private planning",
        description: null,
        timeZone: "Asia/Kolkata",
        visibility: "restricted",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
        mutationId: randomUUID(),
      },
    });
    expect(project.status()).toBe(201);
    const { id: projectId } = await project.json();
    const projectApi = `${api}/projects/${projectId}`;
    const memberPath = `${projectApi}/members/${contributorId}`;
    expect(
      (
        await leadContext.request.patch(memberPath, {
          headers,
          data: {
            role: "contributor",
            expectedVersion: null,
            mutationId: randomUUID(),
          },
        })
      ).ok(),
    ).toBe(true);
    const work = await leadContext.request.post(`${projectApi}/work`, {
      headers,
      data: {
        kind: "task",
        title: "Coordinate checkout validation",
        status: "ready",
        description: null,
        ownerId: null,
        estimateDays: null,
        deadline: null,
        commitment: null,
        blockerReason: null,
        blockerOwnerId: null,
        blockerResolution: null,
        mutationId: randomUUID(),
      },
    });
    expect(work.status()).toBe(201);
    const { id: taskId } = await work.json();
    const discussionPath = `${projectApi}/discussions/task/${taskId}`;
    const projectDiscussion = `${projectApi}/discussions/project/${projectId}`;
    const projectUrl = `/w/${workspaceId}/projects/${projectId}`;
    const taskUrl = `${projectUrl}/work/${taskId}`;
    const snapshot = async () =>
      commentSnapshotSchema.parse(
        await (await leadContext.request.get(discussionPath)).json(),
      );
    const initial = await snapshot();
    const scope = {
      workspaceId,
      projectId,
      subject: { kind: "task", id: taskId },
      cursor: initial.cursor,
    };
    expect(await joinRoom(outsiderPage, scope)).toBe(
      '44{"message":"unavailable"}',
    );
    expect(
      await joinRoom(leadPage, {
        ...scope,
        subject: { kind: "task", id: randomUUID() },
      }),
    ).toBe('44{"message":"unavailable"}');
    expect((await outsiderContext.request.get(discussionPath)).status()).toBe(
      404,
    );

    await leadPage.goto(projectUrl);
    const projectPanel = leadPage.getByRole("region", { name: "Discussion" });
    await projectPanel
      .getByLabel("New comment")
      .fill("Review the rollout across all work.");
    await projectPanel.getByRole("button", { name: "Post comment" }).click();
    await expect(
      projectPanel.getByText("Review the rollout across all work."),
    ).toHaveCount(1);
    expect(
      commentSnapshotSchema.parse(
        await (await leadContext.request.get(projectDiscussion)).json(),
      ).items,
    ).toHaveLength(1);

    await contributorPage.routeWebSocket("**/realtime/**", (wire) => {
      contributorWire = wire;
      const server = wire.connectToServer();
      wire.onMessage((message) => {
        if (!suppressHeartbeat || message !== '42["discussion:heartbeat"]')
          server.send(message);
      });
      server.onMessage((message) => {
        if (typeof message === "string") contributorFrames.push(message);
        wire.send(message);
      });
    });
    await Promise.all([leadPage.goto(taskUrl), contributorPage.goto(taskUrl)]);
    const leadPanel = leadPage.getByRole("region", { name: "Discussion" });
    const contributorPanel = contributorPage.getByRole("region", {
      name: "Discussion",
    });
    await expect(leadPanel.getByText("Here now: Devika, Kai")).toBeVisible();
    await expect(contributorPanel.getByText("No comments yet.")).toBeVisible();
    await expect(
      contributorPanel.getByText("Review the rollout across all work."),
    ).toHaveCount(0);

    // Delay the reconnect's HTTP replay until the same committed event arrives live.
    let releaseReplay!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayStarted = false;
    let replayIds: string[] = [];
    await contributorPage.route(
      `**${discussionPath}/events?*`,
      async (route) => {
        replayStarted = true;
        await gate;
        const response = await route.fetch();
        replayIds = commentFeedSchema
          .parse(await response.json())
          .events.map(({ id }) => id);
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    const wire = contributorWire;
    if (!wire) throw new Error("Expected the contributor WebSocket");
    await contributorPanel.getByLabel("New comment").focus();
    await wire.close({ code: 1012, reason: "Test reconnect" });
    await expect.poll(() => replayStarted).toBe(true);

    const body = "The checkout fixture is ready.";
    await leadPanel.getByLabel("New comment").fill(body);
    await leadPanel
      .getByLabel("Mention a teammate")
      .selectOption(contributorId);
    let finishPost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      finishPost = resolve;
    });
    let mutationId = "";
    let sent: object | undefined;
    await leadPage.route(`**${discussionPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      sent = route.request().postDataJSON();
      mutationId = route.request().postDataJSON().mutationId;
      await postGate;
      await route.continue();
    });
    await leadPanel.getByRole("button", { name: "Post comment" }).click();
    try {
      await expect(leadPanel.getByText("Sending…")).toBeVisible();
      await expect(
        leadPanel.getByRole("list").first().getByText(body, { exact: true }),
      ).toHaveCount(1);
    } finally {
      finishPost();
    }
    try {
      await expect
        .poll(() =>
          contributorFrames.find((frame) => frame.includes('"comment.posted"')),
        )
        .toBeDefined();
    } finally {
      releaseReplay();
    }
    await expect(
      contributorPanel.getByText("1 new comment received."),
    ).toHaveCount(1);
    await expect(contributorPanel.getByText(body, { exact: true })).toHaveCount(
      1,
    );
    await expect(contributorPanel.getByText("Mentions @Kai")).toBeVisible();
    await expect(contributorPanel.getByLabel("New comment")).toBeFocused();
    const liveEvent = JSON.parse(
      contributorFrames
        .find((frame) => frame.includes('"comment.posted"'))!
        .slice(2),
    )[1];
    expect(replayIds).toContain(liveEvent.id);
    await expect(leadPanel.getByText("Sending…")).toHaveCount(0);
    await expect(leadPanel.getByText(body, { exact: true })).toHaveCount(1);
    const rootId = (await snapshot()).items[0]?.id;
    if (!rootId) throw new Error("Expected the saved thread");
    expect(
      await (
        await leadContext.request.post(discussionPath, { headers, data: sent })
      ).json(),
    ).toEqual({ id: rootId });
    const receipts = await owner`
      SELECT o.id FROM public.outbox o JOIN public.audit_events a USING (id)
      WHERE o.mutation_id = ${mutationId} AND o.target_id = ${rootId} AND a.action = 'comment.posted'
    `;
    expect(receipts.map(({ id }) => id)).toEqual([liveEvent.id]);

    // Stop refreshing the contributor's presence while keeping the transport and comment feed open.
    suppressHeartbeat = true;
    await expect(
      leadPanel.getByText("Here now: Devika", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      contributorPanel.getByText(body, { exact: true }),
    ).toBeVisible();
    await expect(leadPanel.getByText(body, { exact: true })).toBeVisible();
    suppressHeartbeat = false;

    await contributorPanel
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await contributorPanel
      .getByLabel("Reply to thread")
      .fill("I will run it now.");
    await contributorPanel.getByRole("button", { name: "Post reply" }).click();
    await expect(
      leadPanel
        .getByRole("list", { name: "Replies" })
        .getByText("I will run it now."),
    ).toBeVisible();
    await leadPanel.getByRole("button", { name: "Edit comment" }).click();
    await leadPanel
      .getByLabel("Edit comment")
      .fill("The checkout fixture is ready for review.");
    await leadPanel.getByRole("button", { name: "Save comment" }).click();
    await expect(
      contributorPanel.getByText("The checkout fixture is ready for review."),
    ).toBeVisible();
    const staleEdit = await leadContext.request.post(discussionPath, {
      headers,
      data: {
        action: "edit",
        commentId: rootId,
        expectedVersion: 1,
        mutationId: randomUUID(),
        body: "A stale edit",
        mentionIds: [],
      },
    });
    expect(staleEdit.status()).toBe(409);
    expect(await staleEdit.json()).toMatchObject({
      current: {
        id: rootId,
        version: 2,
        body: "The checkout fixture is ready for review.",
      },
    });
    await leadPanel.getByRole("button", { name: "Resolve thread" }).click();
    await expect(
      contributorPanel.getByText("Resolved by Devika"),
    ).toBeVisible();
    await expect(
      contributorPanel.getByRole("button", { name: "Reply", exact: true }),
    ).toHaveCount(0);
    await leadPanel.getByRole("button", { name: "Reopen thread" }).click();
    await expect(
      contributorPanel.getByRole("button", { name: "Reply", exact: true }),
    ).toBeVisible();

    const dialog = leadPage.getByRole("dialog");
    for (const width of [1440, 1024, 390, 320]) {
      await leadPage.setViewportSize({ width, height: 760 });
      await expect(leadPanel).toBeVisible();
      expect(
        await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }

    expect(
      (
        await leadContext.request.patch(memberPath, {
          headers,
          data: {
            role: null,
            expectedVersion: 1,
            mutationId: randomUUID(),
          },
        })
      ).ok(),
    ).toBe(true);
    const deniedReplay = await contributorContext.request.get(
      `${discussionPath}/events?after=${initial.cursor}`,
    );
    expect(deniedReplay.status()).toBe(404);
    await expect
      .poll(() =>
        contributorFrames.includes('42["discussion:access","revoked"]'),
      )
      .toBe(true);
    await expect(
      contributorPage.getByRole("heading", { name: "Project unavailable" }),
    ).toBeVisible();
    const afterRemoval = await leadContext.request.post(discussionPath, {
      headers,
      data: {
        action: "post",
        body: "Private follow-up after removal",
        mentionIds: [],
        parentId: null,
        mutationId: randomUUID(),
      },
    });
    expect(afterRemoval.ok()).toBe(true);
    await expect(
      leadPanel.getByText("Private follow-up after removal"),
    ).toBeVisible();
    const newer = commentFeedSchema
      .parse(
        await (
          await leadContext.request.get(
            `${discussionPath}/events?after=${initial.cursor}`,
          )
        ).json(),
      )
      .events.at(-1);
    expect(newer).toBeDefined();
    expect(contributorFrames.some((frame) => frame.includes(newer!.id))).toBe(
      false,
    );

    for (const [id, count] of [
      [leadId, 4],
      [contributorId, 0],
      [outsiderId, 0],
    ] as const) {
      await runtime.begin(async (tx) => {
        await setDatabaseScope(tx, id, workspaceId);
        const [row] =
          await tx`SELECT count(*)::int AS count FROM public.comments WHERE workspace_id = ${workspaceId}`;
        expect(row?.count).toBe(count);
      });
    }
  } finally {
    await Promise.all([
      leadContext.close(),
      contributorContext.close(),
      outsiderContext.close(),
    ]);
    await Promise.all([stopProvider(), owner.end(), runtime.end()]);
  }
});
