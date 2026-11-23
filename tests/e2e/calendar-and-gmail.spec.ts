import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  connectorDirectorySchema,
  connectorSourcesSchema,
  connectorSourceSchema,
  decisionSchema,
  googlePermissions,
  meetingDetailSchema,
  meetingPageSchema,
  proposalDetailSchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const calendar = "launch@group.calendar.google.com";
const label = "Label_42";
const title = "Launch readiness";
const moved = "Rescheduled launch readiness";
const excerpt = "Launch can proceed after the review.";
const privateBody = "Private compensation notes.";
const privateReply = "Personal reply in the same thread.";
const attendee = {
  name: "Calendar attendee",
  email: "calendar-attendee@example.test",
  email_verified: true,
};
const account = (name: string) => ({
  name,
  email: `${randomUUID()}@example.test`,
  email_verified: true,
});

async function googleFixture(baseURL: string) {
  let phase: "initial" | "partial" | "update" | "cancel" | "rebuild" =
    "initial";
  let subject = "google-owner";
  let callback = "";
  const codes = new Map<
    string,
    { challenge: string; scope: string; subject: string }
  >();
  const calls: { path: string; query: URLSearchParams }[] = [];
  const calendarEntry = {
    id: calendar,
    accessRole: "owner",
    summary: "Launch calendar",
    timeZone: "America/New_York",
  };
  const event = {
    id: "event-1",
    status: "confirmed",
    summary: title,
    updated: "2026-11-01T15:00:00Z",
    start: { dateTime: "2026-11-24T14:00:00-05:00" },
    attendees: [{ email: attendee.email }],
  };
  const eventMoved = {
    ...event,
    summary: moved,
    updated: "2026-11-02T15:00:00Z",
    start: { dateTime: "2026-11-25T15:00:00", timeZone: "America/New_York" },
  };
  const canceled = { id: event.id, status: "cancelled" };
  const allDay = {
    id: "event-2",
    summary: "All-day stage review",
    start: { date: "2026-11-26" },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const { pathname: path, searchParams: query } = url;
    const send = (status: number, data: object = {}) =>
      response
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
    calls.push({ path, query });
    if (path === "/authorize") {
      const redirect = baseURL + "/api/connectors/google/callback";
      const challenge = query.get("code_challenge");
      const scope = query.get("scope");
      const state = query.get("state");
      if (
        query.get("redirect_uri") !== redirect ||
        query.get("client_id") !== "kordos-google-test-client" ||
        query.get("code_challenge_method") !== "S256" ||
        query.get("access_type") !== "offline" ||
        !challenge ||
        !scope ||
        !state
      )
        return send(400);
      const allowed = [
        ["openid", ...googlePermissions.calendar].join(" "),
        ["openid", ...googlePermissions.gmail].join(" "),
      ];
      if (!allowed.includes(scope)) return send(400);
      const code = randomUUID();
      codes.set(code, { challenge, scope, subject });
      callback = redirect + "?" + new URLSearchParams({ code, state });
      return response.writeHead(302, { Location: callback }).end();
    }
    if (path === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (
        form.get("client_id") !== "kordos-google-test-client" ||
        form.get("client_secret") !== "kordos-google-test-secret"
      )
        return send(400);
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== "refresh:google-owner")
          return send(400, { error: "invalid_grant" });
        return send(200, { access_token: "access:google-owner" });
      }
      const code = form.get("code") ?? "";
      const login = codes.get(code);
      if (
        !login ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("redirect_uri") !==
          baseURL + "/api/connectors/google/callback" ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== login.challenge
      )
        return send(400);
      codes.delete(code);
      return send(200, {
        access_token: `access:${login.subject}`,
        refresh_token: `refresh:${login.subject}`,
        scope: login.scope,
      });
    }
    const token = request.headers.authorization;
    if (path === "/userinfo" && token?.startsWith("Bearer access:"))
      return send(200, { sub: token.slice("Bearer access:".length) });
    if (token !== "Bearer access:google-owner") return send(401);
    if (path === "/calendar/v3/users/me/calendarList") {
      return query.has("pageToken")
        ? send(200, {
            items: [
              {
                id: "unselected@example.test",
                accessRole: "reader",
                summary: "Personal calendar",
              },
            ],
          })
        : send(200, {
            items: [calendarEntry],
            nextPageToken: "calendars-page-2",
          });
    }
    if (
      path ===
      `/calendar/v3/users/me/calendarList/${encodeURIComponent(calendar)}`
    )
      return send(200, calendarEntry);
    if (
      path === `/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`
    ) {
      const sync = query.get("syncToken");
      if (query.get("showDeleted") !== "true") return send(400);
      if (phase === "rebuild" && sync) return send(410);
      if (phase === "partial" && sync) {
        return query.has("pageToken")
          ? send(400)
          : send(200, { items: [eventMoved], nextPageToken: "partial-events" });
      }
      const timeZone = calendarEntry.timeZone;
      if (phase === "update")
        return send(200, {
          items: [eventMoved],
          timeZone,
          nextSyncToken: "calendar-2",
        });
      if (phase === "cancel")
        return send(200, {
          items: [canceled],
          timeZone,
          nextSyncToken: "calendar-3",
        });
      if (query.has("pageToken"))
        return send(200, {
          items: [allDay],
          timeZone,
          nextSyncToken: phase === "rebuild" ? "calendar-4" : "calendar-1",
        });
      return send(200, {
        items: [phase === "rebuild" ? canceled : event],
        timeZone,
        nextPageToken: "events-page-2",
      });
    }
    const gmail = "/gmail/v1/users/me/";
    if (path === gmail + "labels")
      return send(200, {
        labels: [
          { id: label, type: "user", name: "Launch project" },
          { id: "INBOX", type: "system", name: "INBOX" },
        ],
      });
    if (path === gmail + "labels/" + label)
      return send(200, { id: label, type: "user" });
    if (path === gmail + "profile")
      return send(200, { historyId: phase === "rebuild" ? "103" : "100" });
    if (path === gmail + "history") {
      if (phase === "rebuild") return send(404);
      if (query.get("startHistoryId") === "100")
        return query.has("pageToken")
          ? send(200, {
              historyId: "102",
              history: [{ messagesAdded: [{ message: { id: "outside" } }] }],
            })
          : send(200, {
              historyId: "102",
              nextPageToken: "mail-history-next",
              history: [{ messagesAdded: [{ message: { id: "reply" } }] }],
            });
      return send(200, { historyId: "102" });
    }
    if (path === gmail + "messages") {
      if (query.get("labelIds") !== label) return send(400);
      return phase === "rebuild" && !query.has("pageToken")
        ? send(200, { messages: [{ id: "reply" }], nextPageToken: "mail-next" })
        : send(200, { messages: [{ id: "initial" }] });
    }
    if (path.startsWith(gmail + "messages/")) {
      const id = path.split("/").at(-1);
      if (id === "outside")
        return query.get("format") === "minimal"
          ? send(200, { labelIds: ["INBOX"] })
          : send(403);
      if (id !== "initial" && id !== "reply") return send(404);
      if (query.get("format") === "minimal")
        return send(200, { labelIds: [label] });
      return send(200, {
        id,
        threadId: "same-thread",
        internalDate: id === "initial" ? "1795600800000" : "1795687200000",
        labelIds: [label],
        payload: {
          mimeType: "text/plain",
          headers: [
            {
              name: "Subject",
              value:
                id === "initial"
                  ? "Private Launch email subject"
                  : "Personal reply",
            },
          ],
          body: {
            data: Buffer.from(
              id === "initial" ? excerpt + "\n" + privateBody : privateReply,
            ).toString("base64url"),
          },
        },
      });
    }
    return send(404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(process.env.TEST_GOOGLE_PORT ?? 4495),
      "127.0.0.1",
      resolve,
    );
  });
  return {
    calls,
    callback: () => callback,
    setPhase: (value: typeof phase) => {
      phase = value;
    },
    setSubject: (value: string) => {
      subject = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function json(request: Promise<APIResponse>, status = 200) {
  const response = await request;
  const body: unknown = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}
async function saved(request: Promise<APIResponse>, status = 201) {
  return ((await json(request, status)) as { id: string }).id;
}

test("Google scopes sync through cursor expiry, Calendar retains decisions, and Gmail shares one excerpt", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(130_000);
  if (
    !baseURL ||
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.DATABASE_URL
  )
    throw new Error("Set browser and database URLs.");
  const ownerAccount = account("Lina");
  const memberAccount = account("Maya");
  const stopOidc = await startOidcFixture(
    { owner: ownerAccount, member: memberAccount, attendee },
    baseURL,
  );
  const google = await googleFixture(baseURL);
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ baseURL })),
  );
  const [owner, member, guest] = (await Promise.all(
    contexts.map((context) => context.newPage()),
  )) as [Page, Page, Page];
  const migration = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const headers = { Origin: baseURL };
  const post = (page: Page, path: string, data: object) =>
    page.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  try {
    await Promise.all([
      signIn(owner, ownerAccount, "/workspace"),
      signIn(member, memberAccount, "/workspace"),
      signIn(guest, attendee, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(
      owner,
      "Google connector studio",
    );
    const api = `/api/workspaces/${workspace}`;
    const invitation = (await json(
      post(owner, api + "/invitations", {
        email: memberAccount.email,
        role: "viewer",
      }),
      201,
    )) as { token: string };
    await json(post(member, "/api/invitations/accept", invitation));
    const project = await saved(
      post(owner, api + "/projects", {
        name: "Launch project",
        description: null,
        visibility: "workspace",
        timeZone: "America/New_York",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
      }),
    );
    const endpoint = `${api}/projects/${project}`;
    const base = `/w/${workspace}/projects/${project}`;
    const settings = `/w/${workspace}/settings`;
    const sources = endpoint + "/connector-sources";
    const directory = async () =>
      connectorDirectorySchema.parse(
        await json(owner.request.get(api + "/connectors")),
      );
    const sourceList = async (page: Page) =>
      connectorSourcesSchema.parse(await json(page.request.get(sources))).items;
    async function sourceId(name: string) {
      await expect
        .poll(async () => (await sourceList(owner)).map(({ title }) => title))
        .toContain(name);
      return (await sourceList(owner)).find(({ title }) => title === name)!.id;
    }
    async function connect(
      provider: "Google Calendar" | "Gmail",
      scope: "Calendar" | "Gmail label",
      name: string,
    ) {
      await owner.goto(settings);
      await owner
        .getByRole("button", { name: "Connect " + provider, exact: true })
        .click();
      const picker = owner.getByRole("heading", {
        name:
          scope === "Calendar"
            ? "Choose a calendar"
            : "Choose a Gmail project label",
      });
      await expect(picker).toBeFocused();
      expect(
        (
          await owner.request.get(google.callback(), { maxRedirects: 0 })
        ).status(),
      ).toBe(404);
      const state = new URL(owner.url()).searchParams.get("googleSelection");
      const selection = `${api}/connectors/google/${state}`;
      expect((await member.request.get(selection)).status()).toBe(404);
      expect(
        (
          await post(owner, selection, {
            projectId: project,
            scope: "unapproved-scope",
          })
        ).status(),
      ).toBe(404);
      for (const width of [1440, 1024, 390, 320]) {
        await owner.setViewportSize({ width, height: 860 });
        await expect
          .poll(() =>
            owner.evaluate(() => document.documentElement.scrollWidth),
          )
          .toBe(width);
      }
      const form = owner.getByRole("form", { name: await picker.innerText() });
      await form.getByLabel("Destination project").selectOption(project);
      await form.getByLabel(scope).selectOption({ label: name });
      await form
        .getByRole("button", { name: "Connect selected source" })
        .click();
      await expect(picker).toBeHidden();
      const connection = () =>
        owner.getByRole("listitem").filter({
          has: owner.getByRole("heading", { name: provider, exact: true }),
        });
      await expect(
        connection().getByText("Healthy", { exact: true }),
      ).toBeVisible();
      return (await directory()).items.find(({ label }) => label === provider)!
        .id;
    }
    async function sync(id: string) {
      const item = (await directory()).items.find((row) => row.id === id)!;
      await json(
        owner.request.patch(api + "/connectors/" + id, {
          headers,
          data: {
            action: "sync",
            mutationId: randomUUID(),
            expectedVersion: item.version,
          },
        }),
        202,
      );
    }
    const getCheckpoint = async (id: string) =>
      (
        await migration<{ checkpoint: string }[]>`
      SELECT checkpoint FROM connector_mappings WHERE installation_id=${id}
    `
      )[0]?.checkpoint;

    const calendarId = await connect(
      "Google Calendar",
      "Calendar",
      "Launch calendar",
    );
    const eventId = await sourceId(title);
    expect(await getCheckpoint(calendarId)).toBe("calendar-1");
    expect((await sourceList(member)).map(({ id }) => id)).not.toContain(
      eventId,
    );
    expect((await guest.request.get(sources)).status()).toBe(404);
    const allDayId = await sourceId("All-day stage review");
    const allDaySource = connectorSourceSchema.parse(
      await json(owner.request.get(sources + "/" + allDayId)),
    );
    expect(new Date(allDaySource.calendar!.startsAt).toISOString()).toBe(
      "2026-11-26T05:00:00.000Z",
    );
    const eventPath = sources + "/" + eventId;
    expect(
      (
        await post(member, eventPath + "/calendar-meeting", { revision: 1 })
      ).status(),
    ).toBe(404);
    await owner.goto(`${base}/documents/sources/${eventId}`);
    await owner
      .getByRole("button", { name: "Add to project meetings" })
      .click();
    await owner
      .getByRole("button", { name: "Confirm calendar attachment" })
      .click();
    await expect(owner.getByText("Linked to Google Calendar")).toBeVisible();
    const meeting = new URL(owner.url()).pathname.split("/").at(-1)!;
    const meetingApi = endpoint + "/meetings/" + meeting;
    const meetingUi = base + "/meetings/" + meeting;
    expect(
      await saved(
        post(owner, eventPath + "/calendar-meeting", { revision: 1 }),
      ),
    ).toBe(meeting);
    expect((await guest.request.get(meetingApi)).status()).toBe(404);
    expect(
      meetingDetailSchema.parse(await json(member.request.get(meetingApi)))
        .title,
    ).toBe(title);
    await owner
      .getByLabel("Paste transcript")
      .fill("Lina: Decision: Ship the pilot in two phases.");
    await owner.getByRole("button", { name: "Process transcript" }).click();
    await owner.getByRole("button", { name: "Review decision" }).click();
    const { identity } = (await json(owner.request.get("/api/session"))) as {
      identity: { id: string };
    };
    await owner.getByLabel("Accountable person").selectOption(identity.id);
    await owner.getByRole("button", { name: "Submit for approval" }).click();
    await owner.getByRole("button", { name: "Approve change" }).click();
    await expect(
      owner.getByRole("link", { name: "Open confirmed decision" }),
    ).toBeVisible();
    const proposal = new URL(owner.url()).pathname.split("/").at(-1)!;
    const review = proposalDetailSchema.parse(
      await json(owner.request.get(api + "/proposals/" + proposal)),
    );
    if (!("meetingDecisionId" in review) || !review.meetingDecisionId)
      throw new Error("The reviewed meeting has no confirmed decision.");
    const decisionId = review.meetingDecisionId;
    const decisionApi = endpoint + "/decisions/" + decisionId;
    const decision = decisionSchema.parse(
      await json(member.request.get(decisionApi)),
    );

    google.setPhase("partial");
    await sync(calendarId);
    await expect
      .poll(
        async () =>
          (await directory()).items.find(({ id }) => id === calendarId)?.issue,
      )
      .toBe("invalid_batch");
    expect(await getCheckpoint(calendarId)).toBe("calendar-1");
    expect(
      meetingDetailSchema.parse(await json(owner.request.get(meetingApi)))
        .title,
    ).toBe(title);
    google.setPhase("update");
    await sync(calendarId);
    await expect.poll(() => getCheckpoint(calendarId)).toBe("calendar-2");
    const updated = meetingDetailSchema.parse(
      await json(owner.request.get(meetingApi)),
    );
    expect(updated.title).toBe(moved);
    expect(new Date(updated.startsAt).toISOString()).toBe(
      "2026-11-25T20:00:00.000Z",
    );

    const gmailId = await connect("Gmail", "Gmail label", "Launch project");
    const privateSource = await sourceId("Private Launch email subject");
    const privateApi = sources + "/" + privateSource;
    expect(await getCheckpoint(gmailId)).toBe("100");
    expect((await member.request.get(privateApi)).status()).toBe(404);
    await owner.goto(`${base}/documents/sources/${privateSource}`);
    await expect(owner.getByText(privateBody, { exact: false })).toBeVisible();
    await owner.getByLabel("Exact excerpt to share").fill(excerpt);
    await owner.getByRole("button", { name: "Preview share" }).click();
    await expect(
      owner.getByText(
        "Members with access to Launch project can read this copy.",
      ),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Share excerpt" }).click();
    await expect(
      owner.getByRole("heading", { name: "Shared email" }),
    ).toBeVisible();
    const sharedId = new URL(owner.url()).pathname.split("/").at(-1)!;
    const shared = connectorSourceSchema.parse(
      await json(member.request.get(sources + "/" + sharedId)),
    );
    expect(shared).toMatchObject({
      title: "Shared email",
      body: excerpt,
      url: null,
      sharedBy: "Lina",
    });
    expect((await guest.request.get(sources + "/" + sharedId)).status()).toBe(
      404,
    );

    google.setPhase("cancel");
    await Promise.all([sync(calendarId), sync(gmailId)]);
    await expect.poll(() => getCheckpoint(calendarId)).toBe("calendar-3");
    await expect.poll(() => getCheckpoint(gmailId)).toBe("102");
    const replyId = await sourceId("Personal reply");
    expect((await member.request.get(sources + "/" + replyId)).status()).toBe(
      404,
    );
    expect(await sourceList(member)).toEqual([
      expect.objectContaining({ id: sharedId }),
    ]);
    await owner.goto(meetingUi);
    await expect(owner.getByText("Calendar event canceled")).toBeVisible();
    await expect(
      owner.getByRole("link", { name: "Open confirmed decision" }),
    ).toBeVisible();
    const retained = decisionSchema.parse(
      await json(member.request.get(decisionApi)),
    );
    expect(retained).toMatchObject({
      id: decision.id,
      conclusion: decision.conclusion,
      confirmedAt: decision.confirmedAt,
      version: decision.version,
    });
    expect(retained.evidence.map(({ excerpt }) => excerpt)).toEqual(
      decision.evidence.map(({ excerpt }) => excerpt),
    );

    google.setPhase("rebuild");
    await Promise.all([sync(calendarId), sync(gmailId)]);
    await expect.poll(() => getCheckpoint(calendarId)).toBe("calendar-4");
    await expect.poll(() => getCheckpoint(gmailId)).toBe("103");
    expect(await sourceId("Personal reply")).toBe(replyId);
    expect(await sourceId("Private Launch email subject")).toBe(privateSource);
    const meetings = meetingPageSchema.parse(
      await json(member.request.get(endpoint + "/meetings")),
    );
    expect(meetings.items).toEqual([
      expect.objectContaining({
        id: meeting,
        title: moved,
        calendarStatus: "canceled",
      }),
    ]);
    expect(await sourceList(member)).toEqual([
      expect.objectContaining({ id: sharedId }),
    ]);
    expect(
      google.calls.some(
        ({ path, query }) =>
          path.endsWith("/history") && query.get("startHistoryId") === "102",
      ),
    ).toBe(true);
    expect(
      google.calls.some(
        ({ path, query }) =>
          path.endsWith("/events") && query.get("syncToken") === "calendar-3",
      ),
    ).toBe(true);
    expect(
      google.calls
        .filter(({ path }) => path.endsWith("/events"))
        .every(({ path }) => path.includes(encodeURIComponent(calendar))),
    ).toBe(true);
    expect(
      google.calls.filter(
        ({ path, query }) =>
          path.endsWith("/messages/outside") && query.get("format") === "full",
      ),
    ).toHaveLength(0);

    await owner.goto(settings);
    google.setSubject("wrong-account");
    await owner.getByRole("button", { name: "Reconnect Gmail" }).click();
    await expect(
      owner.getByRole("alert").filter({ hasText: "original Google account" }),
    ).toBeVisible();
    expect(await getCheckpoint(gmailId)).toBe("103");
    google.setSubject("google-owner");
    await owner.getByRole("button", { name: "Reconnect Gmail" }).click();
    await expect(
      owner.getByRole("alert").filter({ hasText: "original Google account" }),
    ).toBeHidden();

    await owner.goto(`${base}/documents/sources/${sharedId}`);
    await owner.getByRole("button", { name: "Revoke share" }).click();
    await owner.getByRole("button", { name: "Confirm revoke" }).click();
    await expect
      .poll(async () =>
        (await member.request.get(sources + "/" + sharedId)).status(),
      )
      .toBe(404);
    await expect(
      runtime`SELECT credential FROM connector_installations`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT body FROM source_revisions`,
    ).rejects.toMatchObject({ code: "42501" });
    const [grant] = await migration<
      { credential: string }[]
    >`SELECT credential FROM connector_installations WHERE id=${gmailId}`;
    expect(grant?.credential).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(grant?.credential).not.toContain("refresh:google-owner");
  } finally {
    await Promise.all([
      migration.end(),
      runtime.end(),
      google.close(),
      stopOidc(),
      ...contexts.map((context) => context.close()),
    ]);
  }
});
