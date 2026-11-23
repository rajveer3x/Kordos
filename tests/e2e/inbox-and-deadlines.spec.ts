import { randomUUID } from "node:crypto";
import {
  graphSchema,
  inboxHomeSchema,
  inboxPageSchema,
  inboxPreferencesSchema,
  proposalDetailSchema,
  riskDetailSchema,
  workFieldsSchema,
  workItemSchema,
  type InboxPreferences,
  type InboxReason,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import postgres from "postgres";
import { emailSink } from "../../infra/email/sink.js";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

function account(name: string) {
  return { name, email: `${randomUUID()}@example.test`, email_verified: true };
}
function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function quietHours() {
  const now = Date.now();
  return {
    start: new Date(now - 3600000).toISOString().slice(11, 16),
    end: new Date(now + 3600000).toISOString().slice(11, 16),
  };
}

test("inbox reschedules quiet deadlines, syncs read state and rechecks access before email", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000);
  const { DATABASE_URL, MIGRATION_DATABASE_URL } = process.env;
  if (!baseURL || !DATABASE_URL || !MIGRATION_DATABASE_URL)
    throw new Error("Set browser and database URLs.");

  const lead = account("Lina");
  const owner = account("Maya");
  const stopOidc = await startOidcFixture({ lead, owner }, baseURL);
  const mail = emailSink({
    status: ({ subject }) =>
      subject === "Work is due soon"
        ? 400
        : subject === "You were mentioned"
          ? 503
          : 200,
  });
  await new Promise<void>((resolve, reject) => {
    mail.server.once("error", reject);
    mail.server.listen(
      Number(process.env.TEST_INBOX_EMAIL_PORT ?? 4492),
      "127.0.0.1",
      resolve,
    );
  });
  const [leadContext, ownerContext, secondContext] = await Promise.all(
    Array.from({ length: 3 }, () => browser.newContext({ baseURL })),
  );
  const [page, peer, second] = await Promise.all([
    leadContext!.newPage(),
    ownerContext!.newPage(),
    secondContext!.newPage(),
  ]);
  const migration = postgres(MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(DATABASE_URL, { max: 1 });
  const headers = { Origin: baseURL };

  async function response<T>(
    result: Promise<APIResponse>,
    status = 200,
  ): Promise<T> {
    const reply = await result;
    const body = await reply.json();
    expect(reply.status(), JSON.stringify(body)).toBe(status);
    return body as T;
  }
  const post = (actor: Page, path: string, data: object) =>
    actor.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const savedId = (result: Promise<APIResponse>, status = 200) =>
    response<{ id: string }>(result, status).then(({ id }) => id);

  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(peer, owner, "/workspace"),
      signIn(second, owner, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Deadline Studio");
    const api = `/api/workspaces/${workspace}`;
    const ui = `/w/${workspace}`;
    const preferencePath = api + "/notification-preferences";
    const inbox = async (actor: Page, filter = "") =>
      inboxPageSchema.parse(
        await response(actor.request.get(api + "/inbox" + filter)),
      );
    const home = async (actor: Page) =>
      inboxHomeSchema.parse(
        await response(actor.request.get(api + "/home?sort=milestone")),
      );
    const rows = (subject: string, reason: InboxReason) =>
      migration<
        {
          id: string;
          revision: number;
          delivered: boolean;
          deferred: boolean;
          canceled: boolean;
          email: string | null;
          slot: string | null;
          attempts: number;
        }[]
      >`
        SELECT id, revision, delivered_at IS NOT NULL AS delivered, next_at > now() AS deferred,
          canceled_at IS NOT NULL AS canceled, email_result AS email, email_slot::text AS slot,
          email_attempts AS attempts FROM public.inbox_entries
        WHERE workspace_id = ${workspace} AND subject_id = ${subject} AND reason = ${reason}
        ORDER BY revision
      `;
    const prefs = async () =>
      inboxPreferencesSchema.parse(
        await response(peer.request.get(preferencePath)),
      );
    const savePrefs = async (patch: Partial<InboxPreferences>) =>
      inboxPreferencesSchema.parse(
        await response(
          peer.request.patch(preferencePath, {
            headers,
            data: { ...(await prefs()), ...patch },
          }),
        ),
      );

    const invitation = await response<{ token: string }>(
      post(page, api + "/invitations", {
        email: owner.email,
        role: "contributor",
      }),
      201,
    );
    await response(post(peer, "/api/invitations/accept", invitation));
    const {
      identity: { id: ownerId },
    } = await response<{ identity: { id: string } }>(
      peer.request.get("/api/session"),
    );
    const project = await savedId(
      post(page, api + "/projects", {
        name: "Private rollout",
        description: null,
        visibility: "restricted",
        timeZone: "America/Los_Angeles",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
      }),
      201,
    );
    const endpoint = `${api}/projects/${project}`;
    const workApi = endpoint + "/work";
    const membership = endpoint + "/members/" + ownerId;
    await response(
      page.request.patch(membership, {
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
    const today = (await getGraph()).asOf;
    const getWork = async (id: string) =>
      workItemSchema.parse(
        await response(page.request.get(workApi + "/" + id)),
      );
    const addWork = (title: string, fields: object = {}) =>
      savedId(
        post(page, workApi, {
          title,
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
          ...fields,
        }),
        201,
      );
    const editWork = async (id: string, fields: object, action = "edit") => {
      const item = await getWork(id);
      return response(
        page.request.patch(workApi + "/" + id, {
          headers,
          data: {
            mutationId: randomUUID(),
            expectedVersion: item.version,
            action,
            ...workFieldsSchema.parse(item),
            ...fields,
          },
        }),
      );
    };
    const commentPath = endpoint + "/discussions/project/" + project;
    const mention = (body: string) =>
      savedId(
        post(page, commentPath, {
          action: "post",
          parentId: null,
          mentionIds: [ownerId],
          body,
        }),
      );

    const initial = await prefs();
    const quiet = await savePrefs({
      timeZone: "UTC",
      quietHours: quietHours(),
      reminderDays: 7,
      escalationDays: 1,
      channels: {
        ...initial.channels,
        assignment: "email",
        due: "email",
        mention: "digest",
      },
    });
    await response(
      second.request.patch(preferencePath, { headers, data: initial }),
      409,
    );
    const oldDeadline = addDays(today, 2);
    const deadline = addDays(today, 3);
    const task = await addWork("API handoff", {
      ownerId,
      deadline: oldDeadline,
    });
    const completed = await addWork("Completed follow-up", {
      ownerId,
      deadline: oldDeadline,
    });
    const archived = await addWork("Archived follow-up", {
      ownerId,
      deadline: oldDeadline,
    });
    await expect
      .poll(async () =>
        (
          await Promise.all(
            [task, completed, archived].map((id) => rows(id, "due")),
          )
        ).every(
          (entries) =>
            entries.length === 1 &&
            entries[0]!.deferred &&
            !entries[0]!.delivered,
        ),
      )
      .toBe(true);

    await editWork(task, { deadline });
    await editWork(completed, { status: "done" });
    await editWork(archived, {}, "archive");
    await expect
      .poll(async () =>
        (await rows(task, "due")).filter((entry) => entry.deferred),
      )
      .toHaveLength(2);
    expect((await inbox(peer, "?reason=due")).items).toEqual([]);

    await peer.goto(ui + "/settings#notifications");
    await expect(peer.getByLabel("Delivery timezone")).toHaveValue(
      quiet.timeZone,
    );
    await peer.getByLabel("Enable quiet hours").uncheck();
    await peer
      .getByRole("button", { name: "Save notification preferences" })
      .click();
    await expect(peer.getByRole("status")).toHaveText(
      "Notification preferences saved.",
    );
    await expect
      .poll(async () =>
        (await rows(task, "due")).map(
          ({ revision, delivered, canceled, email }) => ({
            revision,
            delivered,
            canceled,
            email,
          }),
        ),
      )
      .toEqual([
        { revision: 1, delivered: false, canceled: true, email: null },
        { revision: 2, delivered: true, canceled: false, email: "failed" },
      ]);
    for (const id of [completed, archived]) {
      expect(await rows(id, "due")).toMatchObject([
        { delivered: false, canceled: true },
      ]);
    }
    expect(
      mail.attempts.filter(({ subject }) => subject === "Work is due soon"),
    ).toHaveLength(1);

    const due = (await inbox(peer, "?reason=due")).items[0]!;
    expect(due).toMatchObject({ subjectId: task, deadline, readAt: null });
    expect((await inbox(peer, "?reason=assignment")).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ subjectId: task })]),
    );
    expect((await home(peer)).due).toMatchObject([
      { subjectId: task, deadline },
    ]);
    await peer.goto(ui + "/workspace");
    await expect(
      peer
        .getByRole("region", { name: "Due work" })
        .getByRole("link", { name: "API handoff" }),
    ).toBeVisible();

    await expect
      .poll(async () => (await rows(task, "assignment"))[0]?.email)
      .toBe("sent");
    const assignments = [...mail.messages.values()].filter(
      ({ subject }) => subject === "Work was assigned to you",
    );
    expect(assignments).toHaveLength(1);
    await second.goto(assignments[0]!.text.split("\n").at(-1)!);
    await expect(
      second.getByRole("heading", { name: "Notification" }),
    ).toBeVisible();
    await expect(
      second.getByRole("link", { name: "API handoff" }),
    ).toBeVisible();
    await response(page.request.get(api + "/inbox/" + due.id), 404);
    await Promise.all([
      peer.goto(ui + "/inbox?reason=due"),
      second.goto(ui + "/inbox?reason=due"),
    ]);
    const readButton = (view: Page, label: string) =>
      view.getByRole("button", { name: label });
    await expect(
      readButton(second, "Mark read Due soon · API handoff"),
    ).toBeVisible();
    await readButton(peer, "Mark read Due soon · API handoff").click();
    await expect(
      readButton(second, "Mark unread Due soon · API handoff"),
    ).toBeVisible();
    await second.getByLabel("Read state").selectOption("unread");
    await expect(
      second.getByText("No notifications match this view."),
    ).toBeVisible();
    for (const width of [1440, 1024, 390, 320]) {
      await peer.setViewportSize({ width, height: 880 });
      await expect
        .poll(() => peer.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      if (width === 1440 || width === 390) {
        await testInfo.attach(`inbox-${width}`, {
          body: await peer.screenshot(),
          contentType: "image/png",
        });
      }
    }
    await peer.getByRole("link", { name: "API handoff" }).click();
    await expect(peer).toHaveURL(new RegExp(`/work/${task}$`));

    const overdue = await addWork("Follow up on missed due date", {
      ownerId,
      deadline: addDays(today, -4),
    });
    await expect
      .poll(async () =>
        (await inbox(peer, "?reason=overdue")).items.map(
          ({ subjectId }) => subjectId,
        ),
      )
      .toEqual([overdue]);
    await expect
      .poll(async () =>
        (await inbox(page, "?reason=escalation")).items.map(
          ({ subjectId }) => subjectId,
        ),
      )
      .toEqual([overdue]);
    await editWork(overdue, { title: "Renamed overdue work" });
    expect(await rows(overdue, "overdue")).toMatchObject([
      { revision: 1, delivered: true },
    ]);

    const digestComment = await mention(
      "Private rollout wording for the original mention.",
    );
    const secondDigest = await mention("One more note for the same digest.");
    await expect
      .poll(async () => (await rows(digestComment, "mention"))[0]?.slot)
      .toBeTruthy();
    await expect
      .poll(async () => (await rows(secondDigest, "mention"))[0]?.slot)
      .toBeTruthy();
    // Make the queued slot eligible without waiting until 08:00 local time.
    await migration`UPDATE public.inbox_entries SET email_at = now() - interval '1 second'
      WHERE subject_id IN (${digestComment}, ${secondDigest}) AND workspace_id = ${workspace}`;
    await expect
      .poll(async () => (await rows(secondDigest, "mention"))[0]?.email)
      .toBe("sent");
    const digests = [...mail.messages.values()].filter(
      ({ subject }) => subject === "Your daily Kordos digest",
    );
    expect(digests).toHaveLength(1);
    const [digest] = digests;
    const digestLink = digest!.text.split("\n").at(-1)!;
    expect(digest!.text).not.toContain("Private rollout");
    await second.goto(digestLink);
    await expect(
      second.getByRole("heading", { name: "Daily digest" }),
    ).toBeVisible();
    await expect(
      second.getByRole("link", { name: "You were mentioned in a comment" }),
    ).toHaveCount(2);
    await second.locator(`a[href$="/comment/${digestComment}"]`).click();
    await expect(
      second.getByText("Private rollout wording for the original mention.", {
        exact: true,
      }),
    ).toBeVisible();

    const monday = addDays(today, 7 + ((8 - new Date(today).getUTCDay()) % 7));
    const launch = await addWork("Launch milestone", {
      kind: "milestone",
      estimateDays: null,
      commitment: monday,
    });
    const qa = await addWork("QA", { estimateDays: 2 });
    for (const [predecessorId, successorId] of [
      [task, qa],
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
    const current = await getWork(task);
    const proposal = await savedId(
      post(peer, endpoint + "/proposals", {
        workId: task,
        targetVersion: current.version,
        command: {
          kind: "work.edit",
          values: { ...workFieldsSchema.parse(current), estimateDays: 2 },
        },
        evidence: [],
      }),
      201,
    );
    const proposed = async () =>
      proposalDetailSchema.parse(
        await response(page.request.get(api + "/proposals/" + proposal)),
      );
    const draft = await proposed();
    await response(
      post(peer, api + "/proposals/" + proposal + "/submit", {
        expectedVersion: draft.version,
        revision: draft.revision,
      }),
    );
    await expect
      .poll(
        async () => (await inbox(page, "?reason=review")).items[0]?.subjectId,
      )
      .toBe(proposal);
    expect((await inbox(peer, "?reason=review")).items).toEqual([]);
    expect(await home(page)).toMatchObject({
      pendingCount: 1,
      reviews: [{ subjectId: proposal, milestone: "Launch milestone" }],
    });
    await page.goto(ui + "/workspace?reviewSort=milestone");
    const pending = page.getByRole("region", { name: "Pending reviews (1)" });
    await expect(
      pending.getByRole("link", { name: "API handoff" }),
    ).toBeVisible();
    await expect(
      pending.getByText("Private rollout · Launch milestone"),
    ).toBeVisible();
    const submitted = await proposed();
    await response(
      post(page, api + "/proposals/" + proposal + "/reject", {
        expectedVersion: submitted.version,
        revision: submitted.revision,
        reason: "Keep the original estimate.",
      }),
    );
    expect(
      (await inbox(page, "?reason=review&state=resolved")).items,
    ).toMatchObject([{ subjectId: proposal, resolved: true }]);
    expect((await home(page)).pendingCount).toBe(0);

    const delay = `API handoff is delayed until ${addDays(monday, -3)} due to a test environment issue.`;
    await savedId(
      post(peer, commentPath, {
        action: "post",
        parentId: null,
        mentionIds: [],
        body: delay,
      }),
    );
    await expect
      .poll(async () => (await inbox(page, "?reason=risk")).items)
      .toHaveLength(1);
    const risk = (await inbox(page, "?reason=risk")).items[0]!;
    expect((await home(peer)).risks).toMatchObject([
      { subjectId: risk.subjectId },
    ]);
    await peer.goto(ui + "/workspace");
    await expect(
      peer
        .getByRole("region", { name: "Open risks" })
        .getByRole("link", { name: "API handoff" }),
    ).toBeVisible();
    const riskPath = endpoint + "/risks/" + risk.subjectId;
    const finding = riskDetailSchema.parse(
      await response(page.request.get(riskPath)),
    );
    await response(
      post(page, riskPath, {
        action: "resolve",
        expectedVersion: finding.version,
        reason: "Confirmed replacement handoff.",
      }),
    );
    expect((await home(peer)).risks).toEqual([]);
    await page.goto(ui + "/inbox?reason=risk&state=resolved");
    await page.getByRole("link", { name: "API handoff" }).click();
    await expect(page).toHaveURL(new RegExp(`/risks/${risk.subjectId}$`));
    await expect(page.getByRole("blockquote")).toHaveText(delay);
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();

    const preferences = await prefs();
    await savePrefs({
      channels: { ...preferences.channels, mention: "email" },
    });
    const privateNote = await mention(
      "Private excerpt for a member who is leaving.",
    );
    await expect
      .poll(async () => (await rows(privateNote, "mention"))[0]?.attempts)
      .toBe(1);
    const [queued] = await rows(privateNote, "mention");
    expect(queued).toMatchObject({ delivered: true, email: null });
    const mentionAttempts = () =>
      mail.attempts.filter(({ subject }) => subject === "You were mentioned");
    expect(mentionAttempts()[0]?.text).not.toContain("Private excerpt");

    await savePrefs({ quietHours: quietHours() });
    const deferredNote = await mention(
      "Private excerpt waiting through quiet hours.",
    );
    await expect
      .poll(async () => (await rows(deferredNote, "mention"))[0]?.deferred)
      .toBe(true);
    await response(
      page.request.patch(membership, {
        headers,
        data: { mutationId: randomUUID(), role: null, expectedVersion: 1 },
      }),
    );
    await savePrefs({ quietHours: null });
    await migration`UPDATE public.inbox_entries SET email_at = now() - interval '1 second' WHERE id = ${queued!.id}`;
    await expect
      .poll(async () => (await rows(privateNote, "mention"))[0]?.email)
      .toBe("suppressed");
    await expect
      .poll(async () => (await rows(deferredNote, "mention"))[0]?.canceled)
      .toBe(true);
    expect(mentionAttempts()).toHaveLength(1);
    expect((await inbox(peer)).items).toEqual([]);
    await response(peer.request.get(api + "/inbox/" + queued!.id), 404);
    await response(peer.request.get(riskPath), 404);
    await second.goto(digestLink);
    await expect(
      second.getByText("No notifications match this view."),
    ).toBeVisible();

    await expect(
      runtime`SELECT * FROM public.inbox_entries`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT kordos_inbox.next_email()`,
    ).rejects.toMatchObject({ code: "42501" });
    const [clocks] = await migration`SELECT
      reminder, due,
      kordos_inbox.quiet_until('2026-11-01 05:30:00+00',
        '{"timeZone":"America/New_York","quietHours":{"start":"22:00","end":"02:00"}}') AS quiet
      FROM kordos_inbox.deadline_times('2026-03-08', 'America/New_York', 1, 2)`;
    expect(clocks).toMatchObject({
      reminder: new Date("2026-03-07T14:00:00Z"),
      due: new Date("2026-03-09T04:00:00Z"),
      quiet: new Date("2026-11-01T07:00:00Z"),
    });
  } finally {
    await Promise.all([
      leadContext!.close(),
      ownerContext!.close(),
      secondContext!.close(),
      stopOidc(),
      migration.end(),
      runtime.end(),
      new Promise<void>((resolve, reject) =>
        mail.server.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
});
