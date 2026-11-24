import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  searchAnswerSchema,
  searchEmbeddingDimensions,
  searchResponseSchema,
  workFieldsSchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import postgres, { type Sql } from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const decisionOne = "Use the blue channel for the release.";
const decisionTwo = "Use the green channel for the release.";
const paraphrase = "Which route should deployment take?";
const conflictQuestion = "Which channel does the release use?";
const privateDocument = "Confidential mandarin ledger";
const privateMirror = "Confidential persimmon patch";
const unsharedMail = "Confidential pomegranate invoice";
const sharedQuote = "Shared windmill capacity for Thursday";
const publicExcerpt = "🧭 The readiness checklist has the rollback rubric.";

function account(name: string) {
  return { name, email: `${randomUUID()}@example.test`, email_verified: true };
}

async function json(response: APIResponse) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

function embedding(text: string) {
  const values = Array<number>(searchEmbeddingDimensions).fill(0);
  const index =
    text === paraphrase || text.includes(decisionOne)
      ? 0
      : text === conflictQuestion || text.includes(decisionTwo)
        ? 1
        : text.includes("\n")
          ? 2
          : 3;
  values[index] = 1;
  return values;
}

async function modelFixture() {
  let outage = false;
  const embeds: string[] = [];
  const answers: {
    question: string;
    evidence: { passage: number; excerpt: string }[];
  }[] = [];
  let deferAnswer: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (request.url === "/v1/embeddings") {
        if (
          payload.model !== "search-embeddings-fixture" ||
          payload.dimensions !== searchEmbeddingDimensions ||
          !Array.isArray(payload.input)
        )
          throw new Error("Unexpected embedding request");
        const input = payload.input as string[];
        embeds.push(...input);
        if (outage) {
          response.writeHead(503).end();
          return;
        }
        result = {
          data: input
            .map((text, index) => ({ index, embedding: embedding(text) }))
            .reverse(),
        };
      } else if (request.url === "/v1/chat/completions") {
        const body = JSON.parse(
          payload.messages[1].content,
        ) as (typeof answers)[number];
        answers.push(body);
        await deferAnswer;
        const conflict =
          body.question === conflictQuestion &&
          body.evidence.some((item) => item.excerpt === decisionOne) &&
          body.evidence.some((item) => item.excerpt === decisionTwo);
        const passages = conflict
          ? body.evidence
              .filter((item) =>
                [decisionOne, decisionTwo].includes(item.excerpt),
              )
              .map((item) => item.passage)
          : body.evidence
              .filter((item) => item.excerpt === sharedQuote)
              .map((item) => item.passage);
        result = {
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  status: conflict
                    ? "conflicting"
                    : passages.length > 0
                      ? "supported"
                      : "insufficient",
                  passages,
                }),
              },
            },
          ],
        };
      } else throw new Error("Unexpected model path");
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(process.env.TEST_SEARCH_MODEL_PORT ?? 4496),
      "127.0.0.1",
      resolve,
    );
  });
  return {
    embeds,
    answers,
    breakEmbeddings: () => {
      outage = true;
    },
    holdAnswer: () => {
      let release = () => {};
      deferAnswer = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectorSources(
  sql: Sql,
  workspace: string,
  project: string,
  actor: string,
) {
  const publicPr = randomUUID();
  const privatePr = randomUUID();
  const email = randomUUID();
  const share = randomUUID();
  await sql.begin(async (tx) => {
    const github = randomUUID();
    const gmail = randomUUID();
    await tx`
      INSERT INTO public.connector_installations (id,workspace_id,owner_id,provider,label,state,github_installation,google_subject)
      VALUES (${github},${workspace},${actor},'github','Search PRs','paused','812341',NULL),
        (${gmail},${workspace},${actor},'gmail','Search mail','paused',NULL,'search_fixture')
    `;
    for (const [index, source, title, body] of [
      [
        17,
        publicPr,
        "Refine the retry manifest",
        "Use jitter in the retry policy.",
      ],
      [18, privatePr, privateMirror, "Keep this branch confidential."],
      [19, email, unsharedMail, unsharedMail + "\n" + sharedQuote],
    ] as const) {
      const mapping = randomUUID();
      const isEmail = source === email;
      const installation = isEmail ? gmail : github;
      const audience = source === publicPr ? "project" : "private";
      const repo = "example/release-" + index;
      const external = isEmail ? "message:19" : "pull:" + index;
      const remote = isEmail
        ? null
        : `https://github.com/${repo}/pull/${index}`;
      await tx`
        INSERT INTO public.connector_mappings (id,workspace_id,installation_id,scope,project_id,audience,provider_audience,verified_until)
        VALUES (${mapping},${workspace},${installation},${repo},${project},${audience},${audience},now()+interval '10 minutes')
      `;
      await tx`
        INSERT INTO public.source_objects (id,workspace_id,installation_id,mapping_id,project_id,external_id,revision)
        VALUES (${source},${workspace},${installation},${mapping},${project},${external},1)
      `;
      await tx`
        INSERT INTO public.source_revisions (workspace_id,project_id,source_id,revision,revision_key,observed_at,title,body,url,github)
        VALUES (${workspace},${project},${source},1,'fixture',now(),${title},${body},${remote},
          ${
            isEmail
              ? null
              : tx.json({
                  repository: repo,
                  repositoryId: "481243",
                  kind: "pull",
                  number: index,
                  nodeId: "PR_Search" + index,
                  state: "open",
                  workIds: [],
                  pull: { draft: false, headSha: null, mergedAt: null },
                })
          })
      `;
    }
    await tx`
      INSERT INTO public.connector_shares (id,workspace_id,project_id,source_id,revision,sharer_id,title,excerpt)
      VALUES (${share},${workspace},${project},${email},1,${actor},'Capacity note',${sharedQuote})
    `;
  });
  return { publicPr, privatePr, share };
}

test("hybrid search grounds answers and checks live access before ranking and after model selection", async ({
  browser,
  baseURL,
}) => {
  const { DATABASE_URL, MIGRATION_DATABASE_URL } = process.env;
  if (!baseURL || !DATABASE_URL || !MIGRATION_DATABASE_URL)
    throw new Error("Set the browser origin and test database URLs.");
  const lead = account("Search lead");
  const viewer = account("Search viewer");
  const another = account("Other tenant");
  const stopOidc = await startOidcFixture({ lead, viewer, another }, baseURL);
  const model = await modelFixture();
  const migration = postgres(MIGRATION_DATABASE_URL);
  const runtime = postgres(DATABASE_URL);
  const contexts = await Promise.all(
    [lead, viewer, another].map(() => browser.newContext({ baseURL })),
  );
  const [leadPage, viewerPage, otherPage] = (await Promise.all(
    contexts.map((context) => context.newPage()),
  )) as [Page, Page, Page];
  const headers = { Origin: baseURL };

  try {
    await Promise.all([
      signIn(leadPage, lead, "/workspace"),
      signIn(viewerPage, viewer, "/workspace"),
      signIn(otherPage, another, "/workspace"),
    ]);
    const actor = (await json(await leadPage.request.get("/api/session")))
      .identity.id as string;
    const viewerId = (await json(await viewerPage.request.get("/api/session")))
      .identity.id as string;
    const workspace = await createTestWorkspace(leadPage, "Search Studio");
    const otherWorkspace = await createTestWorkspace(
      otherPage,
      "Search Studio",
    );
    const api = `/api/workspaces/${workspace}`;
    const search = `/w/${workspace}/search`;
    const { token } = await json(
      await leadPage.request.post(api + "/invitations", {
        headers,
        data: { email: viewer.email, role: "viewer" },
      }),
    );
    await json(
      await viewerPage.request.post("/api/invitations/accept", {
        headers,
        data: { token },
      }),
    );

    async function project(
      page: Page,
      workspaceId: string,
      visibility: string,
    ) {
      return (
        await json(
          await page.request.post(`/api/workspaces/${workspaceId}/projects`, {
            headers,
            data: {
              name: "Release",
              visibility,
              timeZone: "Asia/Kolkata",
              workdays: [1, 2, 3, 4, 5],
              nonworkingDates: [],
              description: null,
              mutationId: randomUUID(),
            },
          }),
        )
      ).id as string;
    }
    const publicProject = await project(leadPage, workspace, "workspace");
    const secretProject = await project(leadPage, workspace, "restricted");
    const neighborProject = await project(
      otherPage,
      otherWorkspace,
      "workspace",
    );
    const openProjectApi = api + "/projects/" + publicProject;
    async function createDocument(
      page: Page,
      projectApi: string,
      title: string,
      content: string,
    ) {
      return (
        await json(
          await page.request.post(projectApi + "/documents", {
            headers,
            data: {
              action: "create",
              mutationId: randomUUID(),
              title,
              content,
            },
          }),
        )
      ).id as string;
    }
    const doc = await createDocument(
      leadPage,
      openProjectApi,
      "Release checklist",
      "## Setup\nThe manifest is signed.\n## Playbook\n" + publicExcerpt,
    );
    const secretDoc = await createDocument(
      leadPage,
      api + "/projects/" + secretProject,
      privateDocument,
      "A shared-looking rollback rubric with confidential mandarin terms.",
    );
    await createDocument(
      otherPage,
      `/api/workspaces/${otherWorkspace}/projects/${neighborProject}`,
      "Other tenant zircon",
      publicExcerpt,
    );
    const decisionIds: string[] = [];
    for (const [question, conclusion, effectiveDate] of [
      ["Release channel A", decisionOne, "2026-11-23"],
      ["Release channel B", decisionTwo, "2026-11-24"],
    ] as const) {
      const { id } = await json(
        await leadPage.request.post(openProjectApi + "/decisions", {
          headers,
          data: {
            action: "draft",
            mutationId: randomUUID(),
            question,
            conclusion,
            effectiveDate,
            accountableId: actor,
            supersedesId: null,
            evidence: [
              {
                kind: "document",
                projectId: publicProject,
                id: doc,
                anchor: { revision: 1, start: 0, end: 13 },
              },
            ],
          },
        }),
      );
      decisionIds.push(id as string);
      await json(
        await leadPage.request.patch(openProjectApi + "/decisions/" + id, {
          headers,
          data: {
            action: "confirm",
            expectedVersion: 1,
            mutationId: randomUUID(),
          },
        }),
      );
    }
    const { id: work } = await json(
      await leadPage.request.post(openProjectApi + "/work", {
        headers,
        data: {
          ...workFieldsSchema.parse({
            title: "Prepare the violet dashboard",
            kind: "task",
            status: "ready",
            ownerId: actor,
            description: "Export the support charts.",
            estimateDays: 1,
            deadline: null,
            commitment: null,
            blockerReason: null,
            blockerOwnerId: null,
            blockerResolution: null,
          }),
          mutationId: randomUUID(),
        },
      }),
    );
    const { id: meeting } = await json(
      await leadPage.request.post(openProjectApi + "/meetings", {
        headers,
        data: {
          title: "Rollout huddle",
          agenda: null,
          startsAt: "2026-11-19T08:00:00Z",
          retentionDays: 30,
          mutationId: randomUUID(),
        },
      }),
    );
    await json(
      await leadPage.request.patch(openProjectApi + "/meetings/" + meeting, {
        headers,
        data: {
          action: "paste",
          content:
            "Nina: Check the aquamarine canary numbers.\nMax: Review the chart.",
          expectedVersion: 1,
          mutationId: randomUUID(),
        },
      }),
    );
    const { publicPr, privatePr, share } = await connectorSources(
      migration,
      workspace,
      publicProject,
      actor,
    );

    async function results(
      page: Page,
      q: string,
      filters: Record<string, string> = {},
    ) {
      const query = new URLSearchParams({ q, ...filters });
      return searchResponseSchema.parse(
        await json(await page.request.get(api + "/search?" + query)),
      );
    }
    async function answer(
      page: Page,
      q: string,
      filters: Record<string, string> = {},
    ) {
      return searchAnswerSchema.parse(
        await json(
          await page.request.post(api + "/search/answer", {
            headers,
            data: { q, ...filters },
          }),
        ),
      );
    }
    async function waitForResult(
      page: Page,
      q: string,
      id: string,
      filters?: Record<string, string>,
    ) {
      await expect
        .poll(async () =>
          (await results(page, q, filters)).items.map((item) => item.id),
        )
        .toContain(id);
    }

    await waitForResult(viewerPage, paraphrase, decisionIds[0]!, {
      type: "decision",
    });
    const semantic = await results(viewerPage, paraphrase, {
      type: "decision",
    });
    expect(semantic.mode).toBe("hybrid");
    expect(semantic.items.map((item) => item.id)).toEqual([decisionIds[0]]);
    await waitForResult(viewerPage, "aquamarine canary", meeting, {
      type: "meeting",
    });
    const transcript = (
      await results(viewerPage, "aquamarine canary", { type: "meeting" })
    ).items[0];
    expect(transcript?.citation?.kind).toBe("meeting");
    expect(transcript?.attribution).toBe("Nina");
    await waitForResult(viewerPage, "violet dashboard", work, {
      project: publicProject,
      owner: actor,
      type: "work",
      from: "2020-01-01",
      to: "2030-01-01",
    });
    expect(
      (
        await results(viewerPage, "violet dashboard", {
          owner: viewerId,
          type: "work",
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await results(viewerPage, "violet dashboard", {
          type: "work",
          to: "2020-01-01",
        })
      ).items,
    ).toEqual([]);
    await waitForResult(viewerPage, "rollback rubric", doc, {
      type: "document",
    });
    await waitForResult(leadPage, secretDoc, secretDoc);
    expect((await results(viewerPage, secretDoc)).items).toEqual([]);
    expect(
      (await results(leadPage, "PR #18")).items.map((item) => item.id),
    ).toEqual([privatePr]);
    expect((await results(viewerPage, "PR #18")).items).toEqual([]);
    expect(
      (
        await answer(leadPage, "persimmon patch", { type: "github" })
      ).passages.map(({ id }) => id),
    ).toEqual([privatePr]);
    expect(
      model.answers.some(({ question }) => question === "persimmon patch"),
    ).toBe(false);
    expect(
      (
        await results(viewerPage, "rollback rubric", { type: "document" })
      ).items.map((item) => item.id),
    ).toEqual([doc]);
    expect(
      (await results(leadPage, "pomegranate", { type: "email" })).items,
    ).toEqual([]);
    expect(
      (await otherPage.request.get(api + "/search?q=release")).status(),
    ).toBe(404);

    await viewerPage.goto(
      search + "?q=" + encodeURIComponent(conflictQuestion) + "&type=decision",
    );
    await expect(
      viewerPage.getByRole("heading", { name: "Search", exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("link", { name: "Release channel A" }),
    ).toBeVisible();
    await viewerPage.getByRole("button", { name: "Get cited answer" }).click();
    await expect(viewerPage.getByText("Sources disagree")).toBeVisible();
    const disagreement = viewerPage.locator(".search-answer-body");
    await expect(disagreement).toContainText(decisionOne);
    await expect(disagreement).toContainText(decisionTwo);
    await expect(disagreement.locator("time")).toHaveCount(2);
    await expect(
      disagreement.getByText(lead.name, { exact: false }),
    ).toHaveCount(2);
    for (const width of [1440, 1024, 390, 320]) {
      await viewerPage.setViewportSize({ width, height: 850 });
      expect(
        await viewerPage.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await expect(
        viewerPage.getByRole("searchbox", { name: "Search workspace" }),
      ).toBeVisible();
    }

    await viewerPage.getByRole("searchbox").fill("rollback rubric");
    await viewerPage.getByLabel("Project").selectOption(publicProject);
    await viewerPage.getByLabel("Type").selectOption("document");
    await viewerPage.getByLabel("Owner").selectOption(actor);
    await viewerPage
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(viewerPage).toHaveURL(
      /q=rollback\+rubric.*project=.*type=document.*owner=/,
    );
    const result = viewerPage.getByRole("link", { name: "Release checklist" });
    await expect(result).toBeVisible();
    await viewerPage.getByRole("button", { name: "Get cited answer" }).click();
    await expect(
      viewerPage.getByText("Insufficient evidence for an answer"),
    ).toBeVisible();
    await expect(viewerPage.locator(".search-answer-body")).toContainText(
      publicExcerpt,
    );
    await result.last().click();
    await expect(viewerPage).toHaveURL(
      /\/documents\/evidence\/document\/.+revision=1/,
    );
    await expect(
      viewerPage.locator(".knowledge-evidence blockquote"),
    ).toContainText(publicExcerpt);
    await viewerPage.goto(search + "?q=unfindable-olivine");
    await expect(viewerPage.getByText(/No matching sources/)).toBeVisible();
    const failSearch = (url: URL) =>
      url.pathname.startsWith("/api/") &&
      url.pathname.endsWith("/search") &&
      url.searchParams.get("q") === "rollback rubric";
    await viewerPage.route(failSearch, (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );
    await viewerPage.getByRole("searchbox").fill("rollback rubric");
    await viewerPage
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(
      viewerPage.getByText("Could not search the workspace."),
    ).toBeVisible();
    await viewerPage.unroute(failSearch);
    await viewerPage.getByRole("button", { name: "Try again" }).click();
    await expect(
      viewerPage.getByRole("link", { name: "Release checklist" }),
    ).toBeVisible();

    await waitForResult(viewerPage, "windmill capacity", share, {
      type: "email",
    });
    const releaseAnswer = model.holdAnswer();
    try {
      const request = answer(viewerPage, "windmill capacity", {
        type: "email",
      });
      await expect
        .poll(() =>
          model.answers.some(
            ({ question }) => question === "windmill capacity",
          ),
        )
        .toBe(true);
      await migration`UPDATE public.connector_shares SET revoked_at=now() WHERE id=${share}`;
      releaseAnswer();
      expect(await request).toEqual({ status: "insufficient", passages: [] });
      expect(
        (await results(viewerPage, "windmill capacity", { type: "email" }))
          .items,
      ).toEqual([]);
    } finally {
      releaseAnswer();
    }

    // Project membership revocation leaves every indexed chunk physically intact.
    await migration`
      INSERT INTO public.project_members (workspace_id,project_id,user_id,role)
      VALUES (${workspace},${secretProject},${viewerId},'viewer')
    `;
    expect(
      (await results(viewerPage, secretDoc)).items.map((item) => item.id),
    ).toEqual([secretDoc]);
    await migration`
      UPDATE public.project_members SET removed_at=now()
      WHERE (workspace_id,project_id,user_id)=(${workspace},${secretProject},${viewerId})
    `;
    const [stale] =
      await migration`SELECT count(*)::int AS count FROM public.search_chunks WHERE source_id=${secretDoc}`;
    expect(stale?.count).toBeGreaterThan(0);
    expect((await results(viewerPage, secretDoc)).items).toEqual([]);
    expect((await answer(viewerPage, secretDoc)).passages).toEqual([]);

    expect(
      (
        await viewerPage.request.get(
          api +
            "/search?" +
            new URLSearchParams({ q: "rubric", project: secretProject }),
        )
      ).status(),
    ).toBe(404);

    model.breakEmbeddings();
    expect(
      (await results(viewerPage, "readiness checklist", { type: "document" }))
        .mode,
    ).toBe("lexical");
    await waitForResult(viewerPage, "PR #17", publicPr);
    for (const exact of [
      "PR #17",
      "example/release-17#17",
      "https://github.com/example/release-17/pull/17",
    ]) {
      const found = await results(viewerPage, exact);
      expect(found.mode).toBe("exact");
      expect(found.items.map(({ id }) => id)).toEqual([publicPr]);
      expect(model.embeds).not.toContain(exact);
    }
    expect(JSON.stringify(model.answers)).not.toContain(privateDocument);
    expect(JSON.stringify(model.answers)).not.toContain(privateMirror);
    expect(JSON.stringify(model.answers)).not.toContain(unsharedMail);
    expect(model.embeds.join("\n")).not.toContain(unsharedMail);
    expect(model.embeds.join("\n")).not.toContain(privateMirror);

    await expect(
      runtime`SELECT passage FROM public.search_chunks`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT * FROM kordos_search.claim_embeddings('unauthorized',${randomUUID()})`,
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await Promise.all([
      ...contexts.map((context) => context.close()),
      model.close(),
      stopOidc(),
      migration.end(),
      runtime.end(),
    ]);
  }
});
