import { createHmac, createPublicKey, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import {
  auditPageSchema,
  connectorDirectorySchema,
  githubActivitySchema,
  proposalDetailSchema,
  reviewResponseSchema,
  type ProposalDetail,
} from "@kordos/contracts";
import { expect, test, type APIResponse } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const secret = "kordos-local-github-webhook-signing-secret";
const scopes = {
  alpha: { id: 141, full_name: "kordos-test/alpha", private: false },
  beta: { id: 142, full_name: "kordos-test/beta", private: false },
  restricted: { id: 143, full_name: "kordos-test/restricted", private: true },
};

function gate() {
  let open: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

test("GitHub repairs missed state and publishes one exact reviewed comment after a timeout", async ({
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  const workspace = process.env.TEST_GITHUB_WORKSPACE;
  const appKey = process.env.TEST_GITHUB_KEY;
  if (
    !baseURL ||
    !workspace ||
    !appKey ||
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.DATABASE_URL
  )
    throw new Error("Set the fixture environment and database URLs.");
  const publicKey = createPublicKey(appKey);
  const accounts = {
    lead: {
      name: "Sasha",
      email: `${randomUUID()}@example.test`,
      email_verified: true,
    },
    reader: {
      name: "Taylor",
      email: `${randomUUID()}@example.test`,
      email_verified: true,
    },
  };
  const stopOidc = await startOidcFixture(accounts, baseURL);
  const tokens = new Map<
    string,
    { scope: keyof typeof scopes; write: boolean }
  >();
  const published: Array<{
    scope: string;
    id: number;
    body: string;
    html_url: string;
    user: { login: string; type: string };
    performed_via_github_app: { id: number };
  }> = [];
  const updated = new Date().toISOString();
  const alpha = {
    node_id: "pr_alpha_7",
    number: 7,
    title: "Release pull request",
    body: "",
    updated_at: updated,
    state: "open",
    merged_at: null as string | null,
    head: { sha: "1".repeat(40) },
  };
  const beta = {
    node_id: "issue_beta_7",
    number: 7,
    title: "Beta issue",
    body: "Beta issue text.",
    updated_at: updated,
    state: "open",
  };
  const privatePR = {
    ...alpha,
    node_id: "pr_private_7",
    title: "Restricted pull request",
  };
  const betaCheck = gate();
  const grantBlocked = gate();
  let holdBetaWrite = false;
  let betaRevoked = false;
  let reconciliations = 0;
  let canRespondToPublish = false;
  let canonicalReads = 0;

  const provider = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://github-fixture");
    const bearer = request.headers.authorization?.slice(7) ?? "";
    const reply = (status: number, body: object) =>
      response
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    const payload = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        repositories?: string[];
        permissions?: Record<string, string>;
        body?: string;
      };
    };
    if (
      request.method === "POST" &&
      url.pathname === "/app/installations/8801/access_tokens"
    ) {
      const [header, claims, signature] = bearer.split(".");
      if (
        !header ||
        !claims ||
        !signature ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        )
      )
        return reply(401, {});
      const jwt = JSON.parse(Buffer.from(claims, "base64url").toString()) as {
        iss: string;
        exp: number;
      };
      if (jwt.iss !== "4455" || jwt.exp <= Date.now() / 1000)
        return reply(401, {});
      const { repositories, permissions } = await payload();
      const scope = repositories?.[0];
      if (
        !scope ||
        !(scope in scopes) ||
        repositories?.length !== 1 ||
        !permissions
      )
        return reply(422, {});
      const write = Object.values(permissions).includes("write");
      if (scope === "beta" && write && holdBetaWrite) {
        grantBlocked.open();
        await betaCheck.waiting;
      }
      if (scope === "beta" && betaRevoked) return reply(422, {});
      const token = randomUUID();
      tokens.set(token, { scope: scope as keyof typeof scopes, write });
      return reply(201, { token, permissions });
    }
    const token = tokens.get(bearer);
    if (!token) return reply(401, {});
    const repo = scopes[token.scope];
    if (url.pathname === "/installation/repositories")
      return reply(200, { repositories: [repo] });
    const root = `/repos/${repo.full_name}`;
    const item =
      token.scope === "alpha"
        ? alpha
        : token.scope === "beta"
          ? beta
          : privatePR;
    if (url.pathname === root + "/issues")
      return reply(200, token.scope === "beta" ? [beta] : []);
    if (url.pathname === root + "/pulls")
      return reply(200, token.scope === "beta" ? [] : [item]);
    if (
      url.pathname ===
      root + (token.scope === "beta" ? "/issues/7" : "/pulls/7")
    ) {
      canonicalReads++;
      return reply(200, item);
    }
    if (url.pathname === root + "/issues/7/comments") {
      if (request.method === "GET") {
        reconciliations++;
        return reply(
          200,
          published.filter(({ scope }) => scope === token.scope),
        );
      }
      if (!token.write || (token.scope === "beta" && betaRevoked))
        return reply(403, {});
      const { body } = await payload();
      if (typeof body !== "string") return reply(422, {});
      const id = published.length + 9001;
      const entry = {
        id,
        scope: token.scope,
        body,
        html_url: `https://github.com/${repo.full_name}/${token.scope === "beta" ? "issues" : "pull"}/7#issuecomment-${id}`,
        user: { login: "kordos-test[bot]", type: "Bot" },
        performed_via_github_app: { id: 4455 },
      };
      published.push(entry);
      if (canRespondToPublish) return reply(201, entry);
      // Accept the POST while leaving the response open past the worker timeout.
      return;
    }
    return reply(404, {});
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(
      Number(process.env.TEST_GITHUB_PORT ?? 4494),
      "127.0.0.1",
      resolve,
    );
  });
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  const [lead, reader] = await Promise.all([
    contexts[0]!.newPage(),
    contexts[1]!.newPage(),
  ]);
  const manager = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const origin = { Origin: baseURL };
  const api = `/api/workspaces/${workspace}`;
  const ui = `/w/${workspace}`;
  const post = (path: string, data: object, page = lead) =>
    page.request.post(path, {
      headers: origin,
      data: { mutationId: randomUUID(), ...data },
    });
  const patch = (path: string, data: object, page = lead) =>
    page.request.patch(path, {
      headers: origin,
      data: { mutationId: randomUUID(), ...data },
    });

  async function json(result: Promise<APIResponse>, expected = 200) {
    const response = await result;
    const raw = await response.text();
    expect(response.status(), raw).toBe(expected);
    return JSON.parse(raw) as unknown;
  }

  async function id(result: Promise<APIResponse>, expected = 201) {
    return ((await json(result, expected)) as { id: string }).id;
  }

  const projectFields = {
    description: null,
    visibility: "workspace",
    timeZone: "UTC",
    workdays: [1, 2, 3, 4, 5],
    nonworkingDates: [],
  };
  const workFields = {
    kind: "task",
    description: null,
    status: "backlog",
    ownerId: null,
    estimateDays: null,
    deadline: null,
    commitment: null,
    blockerReason: null,
    blockerOwnerId: null,
    blockerResolution: null,
  };

  function delivery(action: string, deliveryId = randomUUID(), signed = true) {
    const body = JSON.stringify({
      action,
      installation: { id: 8801 },
      repository: scopes.alpha,
      pull_request: { ...alpha, state: "open", merged_at: null, action },
    });
    return lead.request.post("/api/connectors/github/webhook", {
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256":
          "sha256=" +
          (signed
            ? createHmac("sha256", secret).update(body).digest("hex")
            : "0".repeat(64)),
      },
      data: body,
    });
  }

  try {
    await Promise.all([
      signIn(lead, accounts.lead, "/workspace"),
      signIn(reader, accounts.reader, "/workspace"),
    ]);
    await expect(lead.getByLabel("Workspace name")).toBeVisible();
    await id(
      post("/api/workspaces", {
        id: workspace,
        name: "GitHub release team",
        timeZone: "UTC",
      }),
    );
    const other = await createTestWorkspace(reader, "Neighbor workspace");
    const neighbor = await id(
      post(
        `/api/workspaces/${other}/projects`,
        { ...projectFields, name: "Neighbor release" },
        reader,
      ),
    );
    const project = await id(
      post(api + "/projects", { ...projectFields, name: "Release project" }),
    );
    const projectApi = api + "/projects/" + project;
    const projectUI = ui + "/projects/" + project;
    expect(
      (
        await post(
          `/api/workspaces/${other}/connectors`,
          {
            provider: "github",
            label: "Foreign installation",
            installationId: "8801",
            scope: scopes.alpha.full_name,
            projectId: neighbor,
            audience: "project",
          },
          reader,
        )
      ).status(),
    ).toBe(404);
    const invitation = (await json(
      post(api + "/invitations", {
        email: accounts.reader.email,
        role: "viewer",
      }),
      201,
    )) as { token: string };
    await json(post("/api/invitations/accept", invitation, reader));
    const task = await id(
      post(projectApi + "/work", { ...workFields, title: "Rollout task" }),
    );
    alpha.body = "Implements rollout\n\nKordos-Work: " + task;
    const unlinked = await id(
      post(projectApi + "/work", { ...workFields, title: "Confirm beta work" }),
    );

    await lead.goto(ui + "/settings");
    await lead.getByText("Connect GitHub repository", { exact: true }).click();
    const connect = lead
      .locator("details")
      .filter({ hasText: "Connect GitHub repository" });
    await connect.getByLabel("Connection name").fill("Release GitHub App");
    await connect
      .getByLabel("Repository", { exact: true })
      .fill(scopes.alpha.full_name);
    await connect.getByLabel("Destination project").selectOption(project);
    await connect.getByLabel("Mirror audience").selectOption("project");
    await connect.getByRole("button", { name: "Connect source" }).click();
    await expect(lead.getByText("Connection saved.")).toBeVisible();
    const connections = async () =>
      connectorDirectorySchema.parse(
        await json(lead.request.get(api + "/connectors")),
      );
    const getConnection = async () =>
      (await connections()).items.find(
        ({ provider }) => provider === "github",
      )!;
    const connection = await getConnection();
    for (const scope of [scopes.beta, scopes.restricted]) {
      await json(
        patch(api + "/connectors/" + connection.id, {
          action: "map",
          expectedVersion: (await getConnection()).version,
          projectId: project,
          scope: scope.full_name,
          audience: "project",
        }),
      );
    }
    const activity = (page = lead, query = "") =>
      json(page.request.get(projectApi + "/github-activity" + query)).then(
        (value) => githubActivitySchema.parse(value).items,
      );
    await expect.poll(async () => (await activity()).length).toBe(3);
    expect(
      (await activity(reader)).map(({ github }) => github.repository).sort(),
    ).toEqual([scopes.alpha.full_name, scopes.beta.full_name]);
    const all = await activity();
    const alphaSource = all.find(
      ({ github }) => github.repository === scopes.alpha.full_name,
    )!;
    const betaSource = all.find(
      ({ github }) => github.repository === scopes.beta.full_name,
    )!;
    const privateSource = all.find(
      ({ github }) => github.repository === scopes.restricted.full_name,
    )!;
    expect(
      (
        await reader.request.get(
          projectApi + "/connector-sources/" + privateSource.id,
        )
      ).status(),
    ).toBe(404);

    expect(
      (
        await post(projectApi + "/github-comment-proposals", {
          githubSourceId: privateSource.id,
          body: "The source has no work link.",
        })
      ).status(),
    ).toBe(409);

    expect((await delivery("opened", randomUUID(), false)).status()).toBe(401);
    const oldId = randomUUID();
    const first = await id(delivery("opened", oldId), 202);
    expect(await id(delivery("opened", oldId), 202)).toBe(first);
    expect((await delivery("edited", oldId)).status()).toBe(409);
    alpha.merged_at = updated;
    alpha.state = "closed";
    await id(delivery("closed"), 202);
    await id(delivery("opened"), 202);
    await expect
      .poll(
        async () =>
          (await activity()).find(({ id }) => id === alphaSource.id)?.github
            .state,
      )
      .toBe("merged");
    await expect.poll(() => canonicalReads).toBeGreaterThanOrEqual(3);
    await expect
      .poll(async () =>
        Number(
          (
            await manager<{ count: string }[]>`
      SELECT count(*) FROM public.source_revisions WHERE source_id=${alphaSource.id}
    `
          )[0]?.count,
        ),
      )
      .toBe(2);
    await lead.goto(projectUI + "/work/" + task);
    await expect(
      lead.getByRole("heading", { name: "GitHub evidence" }),
    ).toBeVisible();
    await expect(lead.getByRole("link", { name: alpha.title })).toBeVisible();
    await expect(lead.getByText("Merged", { exact: true })).toBeVisible();
    await lead.goto(projectUI + "/activity");
    await expect(
      lead.getByRole("heading", { name: "GitHub activity" }),
    ).toBeVisible();
    await expect(lead.getByRole("link", { name: alpha.title })).toBeVisible();

    // Provider state changes without a webhook and is repaired by the connector sync.
    alpha.title = "Rollout merged and verified";
    alpha.head = { sha: "2".repeat(40) };
    const ready = await getConnection();
    await json(
      patch(api + "/connectors/" + ready.id, {
        action: "sync",
        expectedVersion: ready.version,
      }),
      202,
    );
    await expect
      .poll(
        async () =>
          (await activity()).find(({ id }) => id === alphaSource.id)?.title,
      )
      .toBe(alpha.title);
    expect(
      (await activity()).find(({ id }) => id === alphaSource.id)?.github.pull
        ?.headSha,
    ).toBe("2".repeat(40));
    for (const width of [1440, 1024, 390, 320]) {
      await lead.setViewportSize({ width, height: 900 });
      await expect(lead.getByRole("link", { name: alpha.title })).toBeVisible();
      expect(
        await lead.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      if (width === 1440 || width === 390)
        await info.attach(`GitHub activity ${width}`, {
          body: await lead.screenshot(),
          contentType: "image/png",
        });
    }
    await lead.setViewportSize({ width: 1100, height: 870 });

    await lead.goto(projectUI + "/documents/sources/" + betaSource.id);
    await lead
      .getByRole("searchbox", { name: "Find work to link" })
      .fill("Confirm beta");
    await lead.getByLabel("Work item").selectOption(unlinked);
    await lead.getByRole("button", { name: "Confirm link" }).click();
    await expect(lead.getByText("Confirmed link")).toBeVisible();
    expect(
      (await activity(lead, `?workId=${unlinked}`)).map(({ id }) => id),
    ).toEqual([betaSource.id]);

    await lead.goto(projectUI + "/documents/sources/" + alphaSource.id);
    await lead.getByText("Draft GitHub comment", { exact: true }).click();
    const message =
      "Release is ready.\n\n- Reviewed staged rollout\n- Verified QA";
    await lead.getByLabel("Comment body").fill(message);
    await lead.getByRole("button", { name: "Save comment proposal" }).click();
    await expect(
      lead.getByRole("heading", { name: "Publish GitHub comment" }),
    ).toBeVisible();
    await expect(
      lead.getByRole("link", { name: "Pull request #7" }),
    ).toHaveAttribute("href", "https://github.com/kordos-test/alpha/pull/7");
    const reviewId = new URL(lead.url()).pathname.split("/").at(-1)!;
    const detail = async (proposalId: string) =>
      proposalDetailSchema.parse(
        await json(lead.request.get(api + "/proposals/" + proposalId)),
      );
    const initial = await detail(reviewId);
    if (initial.kind !== "github" || !initial.githubComment)
      throw new Error("Expected a GitHub proposal.");
    const renderedBody = await lead
      .locator(".review-comment-body")
      .textContent();
    expect(renderedBody).toBe(initial.githubComment.body);
    expect(renderedBody).toBe(
      `${message}\n\n<!-- Kordos delivery ${reviewId}/1 -->`,
    );
    await lead.setViewportSize({ width: 390, height: 940 });
    expect(
      await lead.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await info.attach("GitHub comment review 390", {
      body: await lead.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await lead.setViewportSize({ width: 1100, height: 870 });
    await lead.getByRole("button", { name: "Submit for review" }).click();
    await expect(
      lead.getByRole("button", { name: "Approve comment" }),
    ).toBeVisible();
    const approved = await detail(reviewId);
    const update = {
      expectedVersion: approved.version,
      revision: approved.revision,
    };
    const reviewApi = api + "/proposals/" + reviewId;
    const approvals = await Promise.all([
      json(
        post(reviewApi + "/approve", {
          ...update,
          destination: { repository: scopes.beta.full_name, number: 7 },
        }),
        202,
      ),
      json(post(reviewApi + "/approve", update), 202),
    ]);
    expect(reviewResponseSchema.parse(approvals[0]).receiptId).toBe(
      reviewResponseSchema.parse(approvals[1]).receiptId,
    );
    await expect(
      lead.getByRole("link", { name: "Open published comment" }),
    ).toHaveAttribute(
      "href",
      published[0]?.html_url ??
        "https://github.com/kordos-test/alpha/pull/7#issuecomment-9001",
      { timeout: 25_000 },
    );
    expect(published.map(({ scope, body }) => ({ scope, body }))).toEqual([
      { scope: "alpha", body: renderedBody },
    ]);
    expect(reconciliations).toBeGreaterThan(0);
    const applied = await detail(reviewId);
    expect(applied.receipt?.remote?.id).toBe("9001");
    expect(applied.receipt?.id).toBe(
      reviewResponseSchema.parse(approvals[0]).receiptId,
    );
    const trail = auditPageSchema.parse(
      await json(
        lead.request.get(
          api + "/audit?eventId=" + applied.receipt?.effectEventId,
        ),
      ),
    );
    expect(trail.items[0]).toMatchObject({
      action: "github.comment_published",
      proposalId: reviewId,
      revision: 1,
      receiptId: applied.receipt?.id,
      actorType: "service",
    });
    await lead.goto(ui + "/audit");
    await lead
      .getByLabel("GitHub comment URL")
      .fill("https://github.com/Kordos-Test/Alpha/pull/7#issuecomment-9001");
    await lead.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(
      lead.getByText("GitHub comment published", { exact: true }),
    ).toBeVisible();
    const reviewLinks = lead.getByRole("link", { name: "Review revision 1" });
    await expect(reviewLinks).toHaveCount(1);
    await reviewLinks.click();
    await expect(lead.locator(".review-comment-body")).toContainText(message);
    await expect(
      lead.getByRole("link", { name: "Open published comment" }),
    ).toBeVisible();
    expect(
      await runtime`SELECT kordos_reviews.run(${applied.receipt?.id ?? randomUUID()}, 'apply') AS called`,
    ).toEqual([{ called: false }]);
    await expect(
      runtime`SELECT github_remote FROM public.executions`,
    ).rejects.toMatchObject({ code: "42501" });

    // Hold the provider permission check after approval, then revoke the repository grant.
    canRespondToPublish = true;
    holdBetaWrite = true;
    const blocked = reviewResponseSchema.parse(
      await json(
        post(projectApi + "/github-comment-proposals", {
          githubSourceId: betaSource.id,
          body: "This issue no longer accepts a release update.",
        }),
        201,
      ),
    );
    async function act(proposal: ProposalDetail, action: string) {
      return json(
        post(`${api}/proposals/${proposal.id}/${action}`, {
          revision: proposal.revision,
          expectedVersion: proposal.version,
        }),
        action === "approve" ? 202 : 200,
      );
    }
    await act(await detail(blocked.id), "submit");
    await act(await detail(blocked.id), "approve");
    await grantBlocked.waiting;
    betaRevoked = true;
    betaCheck.open();
    await expect
      .poll(async () => (await detail(blocked.id)).receipt?.issue)
      .toBe("destination_unavailable");
    expect(published).toHaveLength(1);
    expect((await detail(blocked.id)).status).toBe("stale");

    betaRevoked = false;
    holdBetaWrite = false;
    const stale = await detail(blocked.id);
    const revised = reviewResponseSchema.parse(
      await json(
        patch(api + "/proposals/" + stale.id, {
          revision: stale.revision,
          expectedVersion: stale.version,
          body: "Issue update after access was restored.",
        }),
      ),
    );
    expect(revised.revision).toBe(2);
    await act(await detail(blocked.id), "submit");
    await act(await detail(blocked.id), "approve");
    await expect
      .poll(async () => (await detail(blocked.id)).receipt?.remote?.url)
      .toBe("https://github.com/kordos-test/beta/issues/7#issuecomment-9002");
    expect(published.map(({ scope }) => scope)).toEqual(["alpha", "beta"]);
    expect(published[1]?.body).toBe(
      `Issue update after access was restored.\n\n<!-- Kordos delivery ${blocked.id}/2 -->`,
    );
  } finally {
    betaCheck.open();
    provider.closeAllConnections();
    await Promise.all([
      stopOidc(),
      manager.end(),
      runtime.end(),
      ...contexts.map((context) => context.close()),
      new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
});
