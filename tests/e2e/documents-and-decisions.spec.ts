import { randomUUID } from "node:crypto";
import {
  commentSnapshotSchema,
  decisionSchema,
  documentDetailSchema,
  projectPeopleSchema,
} from "@kordos/contracts";
import { setDatabaseScope } from "@kordos/db";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const run = randomUUID();
const lead = {
  name: "Maya",
  email: "maya-" + run + "@example.test",
  email_verified: true,
};
const contributor = {
  name: "Luis",
  email: "luis-" + run + "@example.test",
  email_verified: true,
};
const viewer = {
  name: "Noor",
  email: "noor-" + run + "@example.test",
  email_verified: true,
};
const quote = "Confidential pilot capacity";
const fileBody = "<h1>Private file</h1>";

async function actor(page: Page) {
  return (await (await page.request.get("/api/session")).json()).identity
    .id as string;
}

test("documents preserve history and decisions hide source evidence after revocation", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  if (!baseURL || !process.env.DATABASE_URL)
    throw new Error("Set the browser origin and runtime database URL.");
  const stopProvider = await startOidcFixture(
    { lead, contributor, viewer },
    baseURL,
  );
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const [leadContext, contributorContext, viewerContext] = await Promise.all(
    Array.from({ length: 3 }, () => browser.newContext({ baseURL })),
  );
  const [leadPage, contributorPage, viewerPage] = await Promise.all([
    leadContext!.newPage(),
    contributorContext!.newPage(),
    viewerContext!.newPage(),
  ]);
  const headers = { Origin: baseURL };

  async function readDocument(path: string) {
    const response = await leadPage.request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return documentDetailSchema.parse(await response.json());
  }

  try {
    await Promise.all([
      signIn(leadPage, lead, "/workspace"),
      signIn(contributorPage, contributor, "/workspace"),
      signIn(viewerPage, viewer, "/workspace"),
    ]);
    const [leadId, contributorId, viewerId] = await Promise.all([
      actor(leadPage),
      actor(contributorPage),
      actor(viewerPage),
    ]);
    const workspace = await createTestWorkspace(leadPage, "Knowledge Studio");
    const api = "/api/workspaces/" + workspace;
    for (const [account, page, role] of [
      [contributor, contributorPage, "contributor"],
      [viewer, viewerPage, "viewer"],
    ] as const) {
      const invitation = await leadPage.request.post(api + "/invitations", {
        headers,
        data: { email: account.email, role },
      });
      expect(invitation.status()).toBe(201);
      const { token } = await invitation.json();
      expect(
        (
          await page.request.post("/api/invitations/accept", {
            headers,
            data: { token },
          })
        ).status(),
      ).toBe(200);
    }
    async function project(name: string, visibility: string) {
      const response = await leadPage.request.post(api + "/projects", {
        headers,
        data: {
          name,
          visibility,
          timeZone: "Asia/Kolkata",
          workdays: [1, 2, 3, 4, 5],
          nonworkingDates: [],
          description: null,
          mutationId: randomUUID(),
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    }
    const privateId = await project("Restricted pilot", "restricted");
    const sharedId = await project("Shared rollout", "workspace");
    const sourceApi = api + "/projects/" + privateId;
    const sharedApi = api + "/projects/" + sharedId;
    const sourceBase =
      "/w/" + workspace + "/projects/" + privateId + "/documents";
    const sharedBase =
      "/w/" + workspace + "/projects/" + sharedId + "/documents/decisions";
    async function member(
      path: string,
      role: string | null,
      expectedVersion: number | null,
    ) {
      const response = await leadPage.request.patch(
        path + "/members/" + contributorId,
        {
          headers,
          data: { role, expectedVersion, mutationId: randomUUID() },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
    }
    await member(sourceApi, "contributor", null);
    await member(sharedApi, "contributor", null);

    await leadPage.goto(sourceBase);
    await expect(leadPage.getByText("No documents yet.")).toBeVisible();
    await leadPage.getByRole("link", { name: "Create document" }).click();
    await leadPage.getByLabel("Document title").fill("Pilot brief");
    const hazardousMarkup =
      '<img src=x onerror="document.documentElement.dataset.executed=1">';
    const initial = "## Pilot review\n🔒 " + quote + "\n\n" + hazardousMarkup;
    await leadPage.getByLabel("Document text").fill(initial);
    await leadPage.getByRole("button", { name: "Bold", exact: true }).click();
    await leadPage
      .getByLabel("Document text")
      .fill(initial + "\n**Approval criteria**");
    await leadPage.getByRole("button", { name: "Create document" }).click();
    await expect(
      leadPage.getByRole("heading", { name: "Pilot brief" }),
    ).toBeVisible();
    await expect(leadPage.locator(".knowledge-rich strong")).toHaveText(
      "Approval criteria",
    );
    await expect(
      leadPage.getByText(hazardousMarkup, { exact: true }),
    ).toBeVisible();
    await expect(leadPage.locator(".knowledge-rich img")).toHaveCount(0);
    const documentUrl = new URL(leadPage.url()).pathname;
    const documentId = documentUrl.split("/").at(-1)!;
    const documentApi = sourceApi + "/documents/" + documentId;

    await leadPage.bringToFront();
    await leadPage.getByText("Select a passage with the keyboard").click();
    const savedText = leadPage.getByLabel("Saved document text");
    await savedText.focus();
    // Position the caret by offset so line wrapping cannot change the selection.
    await savedText.evaluate((editor: HTMLTextAreaElement, excerpt) => {
      const start = editor.value.indexOf(excerpt);
      editor.setSelectionRange(start, start);
    }, quote);
    for (let index = 0; index < quote.length; index++) {
      await leadPage.keyboard.press("Shift+ArrowRight");
    }
    const selected = leadPage.getByRole("link", {
      name: "Open selected passage",
    });
    await expect(selected).toBeVisible();
    const evidenceUrl = (await selected.getAttribute("href"))!;
    const evidenceApi = evidenceUrl
      .replace("/w/", "/api/workspaces/")
      .replace("/documents/evidence/", "/evidence/");
    await leadPage
      .getByLabel("Comment on selected passage")
      .fill("Carry this into the pilot review.");
    await leadPage.getByRole("button", { name: "Post comment" }).click();
    await expect(
      leadPage.getByRole("link", { name: "Passage from revision 1" }),
    ).toHaveAttribute("href", evidenceUrl);
    const discussion = sourceApi + "/discussions/document/" + documentId;
    const posted = commentSnapshotSchema.parse(
      await (await leadPage.request.get(discussion)).json(),
    ).items[0]!;
    expect(posted.anchor?.revision).toBe(1);
    const commentEvidenceUrl = (await leadPage
      .getByRole("link", { name: "Comment citation" })
      .getAttribute("href"))!;
    expect(commentEvidenceUrl).toContain(posted.id);
    const invalid = await leadPage.request.post(discussion, {
      headers,
      data: {
        action: "post",
        mutationId: randomUUID(),
        parentId: null,
        body: "Invalid",
        mentionIds: [],
        anchor: { revision: 1, start: 500, end: 510 },
      },
    });
    expect(invalid.status()).toBe(400);

    await contributorPage.goto(documentUrl);
    await contributorPage
      .getByRole("button", { name: "Edit document" })
      .click();
    const draft = "Luis's unsaved notes";
    await contributorPage.getByLabel("Document text").fill(draft);
    // Keep the stale editor pinned until its actual save receives the server's conflict.
    let holdRefresh = true;
    let resumeRefresh: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      resumeRefresh = resolve;
    });
    await contributorPage.route(
      "**/api/workspaces/**/documents/" + documentId,
      async (route) => {
        if (route.request().method() === "GET" && holdRefresh) await held;
        await route.continue();
      },
    );
    await leadPage.getByRole("button", { name: "Edit document" }).click();
    await leadPage.getByLabel("Document title").fill("Updated pilot brief");
    await leadPage
      .getByLabel("Document text")
      .fill("Current scope excludes the pilot.");
    await leadPage.getByRole("button", { name: "Save revision" }).click();
    await expect(
      leadPage.getByRole("heading", { name: "Updated pilot brief" }),
    ).toBeVisible();
    const conflict = contributorPage.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(documentApi) &&
        response.status() === 409,
    );
    await contributorPage
      .getByRole("button", { name: "Save revision" })
      .click();
    expect((await (await conflict).json()).current.entry.revision).toBe(2);
    holdRefresh = false;
    resumeRefresh();
    await expect(
      contributorPage.getByRole("heading", { name: "Compare revisions" }),
    ).toBeVisible();
    await expect(
      contributorPage.getByText("Current scope excludes the pilot."),
    ).toBeVisible();
    await expect(contributorPage.getByLabel("Document text")).toHaveValue(
      draft,
    );
    await contributorPage
      .getByRole("button", { name: "Continue editing on latest revision" })
      .click();
    await expect(contributorPage.getByLabel("Document title")).toHaveValue(
      "Updated pilot brief",
    );
    await contributorPage
      .getByLabel("Document text")
      .fill("Current scope excludes the pilot.\n" + draft);
    await contributorPage
      .getByRole("button", { name: "Save revision" })
      .click();
    await expect(
      contributorPage.getByText(draft, { exact: true }),
    ).toBeVisible();
    expect((await readDocument(documentApi)).entry.baseRevision).toBe(2);

    await leadPage.goto(evidenceUrl);
    await expect(leadPage.locator("blockquote")).toHaveText(quote);
    await expect(
      leadPage.getByText("Newer revision available", { exact: false }),
    ).toBeVisible();
    await leadPage.getByRole("link", { name: "Open full revision" }).click();
    await expect(
      leadPage.getByRole("heading", { name: "Pilot brief" }),
    ).toBeVisible();
    await leadPage
      .getByRole("button", { name: "Restore as new revision" })
      .click();
    await expect(leadPage).toHaveURL(new RegExp(documentId + "$"));
    expect((await readDocument(documentApi)).entry).toMatchObject({
      restoredFrom: 1,
      baseRevision: 3,
      revision: 4,
    });

    await leadPage.getByLabel("Choose attachment").setInputFiles({
      name: "private <report>.html",
      mimeType: "text/html",
      buffer: Buffer.from(fileBody),
    });
    await leadPage.getByRole("button", { name: "Upload attachment" }).click();
    const attachment = leadPage.getByRole("link", {
      name: "private <report>.html",
    });
    await expect(attachment).toBeVisible();
    const download = (await attachment.getAttribute("href"))!;
    const authorized = await contributorPage.request.get(download);
    expect(authorized.status()).toBe(200);
    expect(authorized.headers()).toMatchObject({
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "content-disposition": expect.stringMatching(/^attachment;/),
      "x-content-type-options": "nosniff",
    });
    expect(await authorized.text()).toBe(fileBody);
    expect((await viewerPage.request.get(download)).status()).toBe(404);
    const unsigned =
      process.env.STORAGE_ENDPOINT +
      "/" +
      process.env.STORAGE_BUCKET +
      "/attachments/" +
      [workspace, privateId, documentId, download.split("/").at(-1)].join("/");
    expect((await leadPage.request.get(unsigned)).status()).toBe(403);

    const attachmentRetryUrl =
      documentApi +
      "/attachments?" +
      new URLSearchParams({
        name: "Pilot data.bin",
        mutationId: randomUUID(),
      });
    const upload = (data: Buffer) =>
      leadPage.request.post(attachmentRetryUrl, {
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        data,
      });
    const data = Buffer.alloc(1024 * 1024 + 1, 5);
    const repeats = await Promise.all([upload(data), upload(data)]);
    for (const response of repeats)
      expect(response.ok(), await response.text()).toBe(true);
    expect(await repeats[0]!.json()).toEqual(await repeats[1]!.json());
    expect((await upload(Buffer.from("Different attachment"))).status()).toBe(
      409,
    );
    expect(
      (await readDocument(documentApi)).attachments.map(({ name }) => name),
    ).toEqual(["private <report>.html", "Pilot data.bin"]);

    await contributorPage.goto(sharedBase + "/new");
    await contributorPage.getByLabel("Question").fill("Why defer the pilot?");
    await contributorPage
      .getByLabel("Conclusion")
      .fill("Defer the pilot until the next review.");
    await contributorPage.getByLabel("Accountable person").selectOption(leadId);
    await contributorPage.getByLabel("Effective date").fill("2026-11-23");
    for (const [link, text] of [
      [evidenceUrl, quote],
      [commentEvidenceUrl, posted.body],
    ] as const) {
      await contributorPage.getByLabel("Evidence link").fill(link);
      await contributorPage
        .getByRole("button", { name: "Add evidence" })
        .click();
      await expect(
        contributorPage.locator("blockquote", { hasText: text }),
      ).toBeVisible();
    }
    await contributorPage
      .getByRole("button", { name: "Save decision draft" })
      .click();
    await expect(
      contributorPage.getByRole("heading", { name: "Why defer the pilot?" }),
    ).toBeVisible();
    const firstDecisionUrl = new URL(contributorPage.url()).pathname;
    const firstDecisionApi =
      sharedApi + "/decisions/" + firstDecisionUrl.split("/").at(-1);
    const confirm = {
      headers,
      data: { action: "confirm", expectedVersion: 1, mutationId: randomUUID() },
    };
    expect(
      (await contributorPage.request.patch(firstDecisionApi, confirm)).status(),
    ).toBe(404);
    expect((await viewerPage.request.get(firstDecisionApi)).status()).toBe(404);
    await leadPage.goto(firstDecisionUrl);
    await leadPage.getByRole("button", { name: "Confirm decision" }).click();
    await expect(
      leadPage.getByText("Confirmed", { exact: true }),
    ).toBeVisible();
    await leadPage
      .getByRole("link", { name: "Draft a superseding decision" })
      .click();
    await leadPage.getByLabel("Question").fill("When can the pilot proceed?");
    await leadPage
      .getByLabel("Conclusion")
      .fill("Proceed after the next staffing review.");
    await leadPage.getByLabel("Accountable person").selectOption(leadId);
    await leadPage.getByLabel("Effective date").fill("2026-12-02");
    await leadPage.getByLabel("Evidence link").fill(evidenceUrl);
    await leadPage.getByRole("button", { name: "Add evidence" }).click();
    await leadPage.getByRole("button", { name: "Save decision draft" }).click();
    await leadPage.getByRole("button", { name: "Confirm decision" }).click();
    await leadPage.getByRole("link", { name: "View earlier decision" }).click();
    await expect(
      leadPage.getByText("Superseded", { exact: true }),
    ).toBeVisible();
    await expect(
      leadPage.getByRole("link", { name: "View superseding decision" }),
    ).toBeVisible();
    await expect(
      leadPage.locator("blockquote", { hasText: quote }),
    ).toBeVisible();

    await viewerPage.goto(firstDecisionUrl);
    await expect(
      viewerPage.getByText("Defer the pilot until the next review."),
    ).toBeVisible();
    await expect(viewerPage.getByText("No evidence available.")).toBeVisible();
    expect(
      await (await viewerPage.request.get(firstDecisionApi)).text(),
    ).not.toContain(privateId);
    expect((await viewerPage.request.get(evidenceApi)).status()).toBe(404);

    await contributorPage.goto(firstDecisionUrl);
    await expect(
      contributorPage.locator("blockquote", { hasText: quote }),
    ).toBeVisible();
    const people = projectPeopleSchema.parse(
      await (await leadPage.request.get(sourceApi + "/people")).json(),
    );
    await member(
      sourceApi,
      null,
      people.members.find(({ id }) => id === contributorId)!.version,
    );
    expect((await contributorPage.request.get(download)).status()).toBe(404);
    expect((await contributorPage.request.get(evidenceApi)).status()).toBe(404);
    const revoked = decisionSchema.parse(
      await (await contributorPage.request.get(firstDecisionApi)).json(),
    );
    expect(revoked.evidence).toEqual([]);
    expect(revoked.supersededOn).toBe("2026-12-02");
    await expect(
      contributorPage.getByText("No evidence available."),
    ).toBeVisible();
    await expect(contributorPage.locator("blockquote")).toHaveCount(0);
    for (const identity of [contributorId, viewerId]) {
      await runtime.begin(async (sql) => {
        await setDatabaseScope(sql, identity, workspace);
        expect(
          await sql`SELECT id FROM documents WHERE id = ${documentId}`,
        ).toEqual([]);
        expect(
          await sql`SELECT content FROM document_versions WHERE document_id = ${documentId}`,
        ).toEqual([]);
      });
    }

    await leadPage.goto(documentUrl);
    await leadPage.getByRole("button", { name: "Archive document" }).click();
    await leadPage.getByRole("button", { name: "Confirm archive" }).click();
    await expect(leadPage.getByText("Archived", { exact: true })).toBeVisible();
    await expect(
      leadPage.getByRole("button", { name: "Edit document" }),
    ).toHaveCount(0);
    await leadPage.getByRole("link", { name: "All documents" }).click();
    await expect(leadPage.getByText("No documents yet.")).toBeVisible();
    await leadPage
      .getByRole("link", { name: "Show archived documents" })
      .click();
    await leadPage
      .getByRole("link", { name: "Pilot brief", exact: true })
      .click();
    await expect(
      leadPage.getByRole("link", { name: "Passage from revision 1" }),
    ).toBeVisible();

    for (const width of [1440, 1024, 390, 320]) {
      await leadPage.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          leadPage.evaluate(() => document.documentElement.scrollWidth),
        )
        .toBeLessThanOrEqual(width);
    }
  } finally {
    await Promise.all([
      leadContext!.close(),
      contributorContext!.close(),
      viewerContext!.close(),
      runtime.end(),
      stopProvider(),
    ]);
  }
});
