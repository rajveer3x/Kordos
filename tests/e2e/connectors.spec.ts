import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  connectorDirectorySchema,
  connectorSourcesSchema,
  connectorSourceSchema,
  type ConnectorChange,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const signingSecret = "kordos-connector-fixture-signing-secret";
const privateScope = "team/private";
const sharedScope = "team/shared";
const secondScope = "team/secondary";
const chosen = "Approved release summary.";
const secretText = "Unshared private provider message.";
const initial = {
  kind: "upsert",
  externalId: "note-1",
  revisionKey: "version-1",
  observedAt: "2026-07-01T00:00:00Z",
  title: "Private rollout brief",
  body: chosen + "\n" + secretText,
  url: "https://example.test/evidence/1",
} satisfies ConnectorChange;
const eventRevision = {
  ...initial,
  revisionKey: "version-2",
  observedAt: "2026-07-02T00:00:00Z",
  body: initial.body + "\nSecond revision.",
} satisfies ConnectorChange;
const partial = {
  ...eventRevision,
  revisionKey: "version-3",
  observedAt: "2026-07-03T00:00:00Z",
  body: eventRevision.body + "\nRecovered from a complete snapshot.",
} satisfies ConnectorChange;

function account(name: string) {
  return { name, email: `${randomUUID()}@example.test`, email_verified: true };
}

test("connector sync deduplicates deliveries, protects private sources and invalidates mirrors before cleanup", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(135_000);
  if (
    !baseURL ||
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.DATABASE_URL ||
    !process.env.BRIEF_WORKER_DATABASE_URL
  ) {
    throw new Error("Set the browser and database URLs.");
  }
  const accounts = {
    lead: account("Lina"),
    admin: account("Alex"),
    viewer: account("Maya"),
  };
  const stopOidc = await startOidcFixture(accounts, baseURL);
  const ownerToken = `private-${randomUUID()}`;
  const sharedToken = `shared-${randomUUID()}`;
  const replacement = `replacement-${randomUUID()}`;
  let mode: "initial" | "broken" | "rebuild" = "initial";
  const revoked = new Set<string>();
  const requests: {
    scope: string;
    checkpoint: string | null;
    page: string | null;
    rebuild: boolean;
  }[] = [];
  const provider = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/scopes\/([^/]+)\/(entitlement|changes)$/.exec(
      url.pathname,
    );
    const send = (status: number, value: object = {}) =>
      response
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    if (!match?.[1]) return send(404);
    const scope = decodeURIComponent(match[1]);
    const token = request.headers.authorization?.slice(7) ?? "";
    if (revoked.has(token)) return send(401);
    if (
      (scope === privateScope &&
        token !== ownerToken &&
        token !== replacement) ||
      (scope === sharedScope && token !== sharedToken)
    )
      return send(404);
    if (
      ![privateScope, sharedScope, secondScope].includes(scope) ||
      (scope === secondScope && token !== sharedToken)
    )
      return send(404);
    if (match[2] === "entitlement")
      return send(200, {
        audience: scope === privateScope ? "private" : "project",
      });
    const checkpoint = url.searchParams.get("checkpoint");
    const page = url.searchParams.get("page");
    const rebuild = url.searchParams.get("rebuild") === "1";
    requests.push({ scope, checkpoint, page, rebuild });
    if (scope === sharedScope || scope === secondScope) {
      return send(200, {
        changes: [
          {
            ...initial,
            title:
              scope === sharedScope
                ? "Shared release note"
                : "Secondary release note",
            body: "Project-visible release note.",
          },
        ],
        checkpoint: "shared-1",
        nextPage: null,
      });
    }
    if (mode === "broken") {
      if (page === "page-2") return send(503);
      return send(200, {
        changes: [partial],
        checkpoint: null,
        nextPage: "page-2",
      });
    }
    if (mode === "rebuild") {
      if (checkpoint === "private-1") return send(410);
      return send(200, {
        changes: [partial],
        checkpoint: "private-2",
        nextPage: null,
      });
    }
    return send(200, {
      changes: [initial],
      checkpoint: "private-1",
      nextPage: null,
    });
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(
      Number(process.env.TEST_CONNECTOR_PORT ?? 4493),
      "127.0.0.1",
      resolve,
    );
  });
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ baseURL })),
  );
  const [page, outsider, reader] = await Promise.all([
    contexts[0]!.newPage(),
    contexts[1]!.newPage(),
    contexts[2]!.newPage(),
  ]);
  const migration = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const headers = { Origin: baseURL };

  async function json<T>(
    request: Promise<APIResponse>,
    status = 200,
  ): Promise<T> {
    const result = await request;
    const body = await result.json();
    expect(result.status(), JSON.stringify(body)).toBe(status);
    return body as T;
  }
  const post = (actor: Page, path: string, data: object) =>
    actor.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const idFrom = (request: Promise<APIResponse>, status = 201) =>
    json<{ id: string }>(request, status).then(({ id }) => id);

  try {
    await Promise.all([
      signIn(page, accounts.lead, "/workspace"),
      signIn(outsider, accounts.admin, "/workspace"),
      signIn(reader, accounts.viewer, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Connector Studio");
    const api = `/api/workspaces/${workspace}`;
    const ui = `/w/${workspace}`;
    for (const [target, identity, role] of [
      [outsider, accounts.admin, "admin"],
      [reader, accounts.viewer, "viewer"],
    ] as const) {
      const invitation = await json<{ token: string }>(
        post(page, api + "/invitations", { email: identity.email, role }),
        201,
      );
      await json(post(target, "/api/invitations/accept", invitation));
    }
    const projectFields = {
      description: null,
      visibility: "restricted",
      timeZone: "UTC",
      workdays: [1, 2, 3, 4, 5],
      nonworkingDates: [],
    };
    const project = await idFrom(
      post(page, api + "/projects", {
        ...projectFields,
        name: "Private release project",
      }),
    );
    const publicProject = await idFrom(
      post(page, api + "/projects", {
        ...projectFields,
        name: "Shared release project",
        visibility: "workspace",
      }),
    );
    const {
      identity: { id: viewerId },
    } = await json<{ identity: { id: string } }>(
      reader.request.get("/api/session"),
    );
    const projectApi = api + "/projects/" + project;
    await json(
      page.request.patch(projectApi + "/members/" + viewerId, {
        headers,
        data: {
          role: "viewer",
          expectedVersion: null,
          mutationId: randomUUID(),
        },
      }),
    );
    const sources = projectApi + "/connector-sources";
    const sourceUi = ui + "/projects/" + project + "/documents/sources";
    const connectors = api + "/connectors";
    const list = async (actor = page) =>
      connectorDirectorySchema.parse(await json(actor.request.get(connectors)));
    const connection = async (id: string) =>
      (await list()).items.find((item) => item.id === id)!;
    const sourceList = async (actor = page) =>
      connectorSourcesSchema.parse(await json(actor.request.get(sources)));
    const action = async (id: string, fields: object, status = 200) =>
      json(
        page.request.patch(connectors + "/" + id, {
          headers,
          data: {
            mutationId: randomUUID(),
            expectedVersion: (await connection(id)).version,
            ...fields,
          },
        }),
        status,
      );
    const mappingState = async (id: string) => {
      const [result] = await migration<
        {
          checkpoint: string | null;
          audience: string;
          credential: string | null;
        }[]
      >`
        SELECT m.checkpoint, m.provider_audience AS audience, i.credential
        FROM public.connector_mappings m JOIN public.connector_installations i ON i.id = m.installation_id
        WHERE i.id = ${id}`;
      return result!;
    };
    const revisions = (source: string) => migration<
      { revision_key: string; body: string | null }[]
    >`
      SELECT revision_key, body FROM public.source_revisions WHERE source_id = ${source} ORDER BY revision`;

    await page.goto(ui + "/settings");
    await page.getByText("Connect a fixture source", { exact: true }).click();
    await page.getByLabel("Connection name").fill("Release connection");
    await page.getByLabel("Access token", { exact: true }).fill(ownerToken);
    await page.getByLabel("Destination project").selectOption(project);
    await page.getByLabel("Provider scope").fill(privateScope);
    await page.getByLabel("Mirror audience").selectOption("project");
    await page.getByRole("button", { name: "Connect source" }).click();
    await expect(
      page.getByRole("heading", { name: "Release connection" }),
    ).toBeVisible();
    const installation = (await list()).items[0]!.id;
    await expect
      .poll(async () => (await connection(installation)).status)
      .toBe("healthy");
    expect(await mappingState(installation)).toMatchObject({
      checkpoint: "private-1",
      audience: "private",
    });
    expect((await mappingState(installation)).credential).not.toContain(
      ownerToken,
    );

    const shared = await idFrom(
      post(page, connectors, {
        provider: "fixture",
        label: "Shared connection",
        token: sharedToken,
        projectId: publicProject,
        scope: sharedScope,
        audience: "project",
      }),
    );
    await expect
      .poll(async () => (await connection(shared)).status)
      .toBe("healthy");
    await action(shared, {
      action: "map",
      projectId: publicProject,
      scope: secondScope,
      audience: "project",
    });
    await expect
      .poll(async () => (await connection(shared)).status)
      .toBe("healthy");
    const publicSources =
      api + "/projects/" + publicProject + "/connector-sources";
    const publicList = async () =>
      connectorSourcesSchema.parse(
        await json(reader.request.get(publicSources)),
      );
    const secondary = (await publicList()).items.find(
      ({ title }) => title === "Secondary release note",
    )!;
    expect(secondary).toBeTruthy();
    await action(shared, { action: "pause" });
    expect((await connection(shared)).status).toBe("paused");
    expect((await publicList()).items).toHaveLength(2);
    await action(shared, { action: "resume" });
    await expect
      .poll(async () => (await connection(shared)).status)
      .toBe("healthy");
    const secondMapping = (await connection(shared)).mappings.find(
      ({ scope }) => scope === secondScope,
    )!;
    await action(shared, { action: "unmap", mappingId: secondMapping.id });
    await json(reader.request.get(publicSources + "/" + secondary.id), 404);
    expect((await publicList()).items).toMatchObject([
      { title: "Shared release note" },
    ]);
    const mirror = (await sourceList()).items[0]!;
    expect(mirror).toMatchObject({ title: initial.title, kind: "mirror" });
    expect((await sourceList(reader)).items).toEqual([]);
    await json(outsider.request.get(sources + "/" + mirror.id), 404);
    await json(reader.request.get(connectors), 404);
    const health = (await list(outsider)).items.find(
      (item) => item.id === installation,
    );
    expect(health).toMatchObject({
      status: "healthy",
      mappings: [
        {
          projectId: null,
          scope: null,
          projectName: null,
          audience: "private",
        },
      ],
    });
    expect(JSON.stringify(health)).not.toContain(secretText);
    await outsider.goto(ui + "/settings");
    const panel = outsider.getByRole("region", { name: "Connectors" });
    await expect(
      panel.getByText("Restricted project", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText(initial.title)).toHaveCount(0);
    for (const width of [1440, 1024, 390, 320]) {
      await outsider.setViewportSize({ width, height: 880 });
      await expect
        .poll(() =>
          outsider.evaluate(() => document.documentElement.scrollWidth),
        )
        .toBe(width);
      if (width === 1440 || width === 390) {
        await testInfo.attach(`connectors-${width}`, {
          body: await outsider.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    }

    const deliveryId = randomUUID();
    async function sendDelivery(
      change: ConnectorChange,
      expectedStatus: number,
      valid = true,
      id = deliveryId,
    ) {
      const body = JSON.stringify({ scope: privateScope, changes: [change] });
      const signature = createHmac("sha256", signingSecret)
        .update(`${installation}\n${id}\n`)
        .update(body)
        .digest("hex");
      const result = await page.request.post(
        `/api/connectors/fixture/${installation}/deliveries`,
        {
          headers: {
            "content-type": "application/json",
            "x-kordos-delivery": id,
            "x-kordos-signature":
              "sha256=" + (valid ? signature : "0".repeat(64)),
          },
          data: body,
        },
      );
      expect(result.status()).toBe(expectedStatus);
      return expectedStatus === 202
        ? ((await result.json()) as { id: string }).id
        : undefined;
    }
    await sendDelivery(eventRevision, 401, false);
    const [first, repeat] = await Promise.all([
      sendDelivery(eventRevision, 202),
      sendDelivery(eventRevision, 202),
    ]);
    expect(first).toBe(repeat);
    await sendDelivery(partial, 409);
    await expect
      .poll(async () =>
        (await revisions(mirror.id)).map(({ revision_key }) => revision_key),
      )
      .toEqual(["version-1", "version-2"]);
    const [receipts] =
      await migration`SELECT count(*)::int AS count FROM public.connector_jobs WHERE installation_id = ${installation} AND delivery_id = ${deliveryId}`;
    expect(receipts?.count).toBe(1);
    await sendDelivery(initial, 202, true, randomUUID());
    expect(
      (await revisions(mirror.id)).map(({ revision_key }) => revision_key),
    ).toEqual(["version-1", "version-2"]);

    mode = "broken";
    await action(installation, { action: "sync" }, 202);
    await expect
      .poll(async () => (await connection(installation)).issue)
      .toBe("provider_unavailable");
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          scope: privateScope,
          checkpoint: "private-1",
          page: "page-2",
          rebuild: false,
        },
      ]),
    );
    expect((await mappingState(installation)).checkpoint).toBe("private-1");
    expect(await revisions(mirror.id)).toHaveLength(2);

    mode = "rebuild";
    await action(installation, { action: "sync" }, 202);
    await expect
      .poll(async () => (await mappingState(installation)).checkpoint)
      .toBe("private-2");
    expect(requests).toEqual(
      expect.arrayContaining([
        { scope: privateScope, checkpoint: null, page: null, rebuild: true },
      ]),
    );
    expect(await revisions(mirror.id)).toHaveLength(3);

    revoked.add(ownerToken);
    await action(installation, { action: "sync" }, 202);
    await expect
      .poll(async () => (await connection(installation)).status)
      .toBe("paused");
    expect((await connection(installation)).issue).toBe("credential_revoked");
    expect((await connection(shared)).status).toBe("healthy");
    await json(page.request.get(sources + "/" + mirror.id), 404);
    await action(installation, { action: "reconnect", token: replacement });
    await expect
      .poll(async () => (await connection(installation)).status)
      .toBe("healthy");
    expect((await sourceList()).items[0]?.id).toBe(mirror.id);

    await page.goto(sourceUi + "/" + mirror.id);
    await expect(page.getByRole("blockquote")).toHaveText(partial.body);
    await page.getByLabel("Exact excerpt to share").fill(chosen);
    await page.getByRole("button", { name: "Preview share" }).click();
    await expect(
      page.getByText(
        "Members with access to Private release project can read this copy.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Share excerpt" }).click();
    await expect(
      page.getByText("Shared excerpt", { exact: true }),
    ).toBeVisible();
    const share = (await sourceList(reader)).items[0]!;
    expect(share.kind).toBe("share");
    const copy = connectorSourceSchema.parse(
      await json(reader.request.get(sources + "/" + share.id)),
    );
    expect(copy.body).toBe(chosen);
    await json(outsider.request.get(sources + "/" + share.id), 404);

    const [outbound] =
      await migration`INSERT INTO public.connector_jobs (workspace_id,installation_id,mapping_id,kind)
      SELECT workspace_id,installation_id,id,'outbound' FROM public.connector_mappings WHERE installation_id = ${installation}
      RETURNING id`;
    await page.goto(sourceUi + "/" + mirror.id);
    await expect(page.getByRole("blockquote")).toBeVisible();
    await action(installation, { action: "disconnect" });
    const disconnected = await connection(installation);
    expect(disconnected).toMatchObject({
      status: "disconnected",
      cleanupPending: true,
    });
    await json(page.request.get(sources + "/" + mirror.id), 404);
    await expect(
      page.getByText("This external source is unavailable."),
    ).toBeVisible();
    expect((await revisions(mirror.id)).at(-1)?.body).toBe(partial.body);
    const [canceled] =
      await migration`SELECT state FROM public.connector_jobs WHERE id = ${outbound!.id}`;
    expect(canceled?.state).toBe("canceled");
    expect((await mappingState(installation)).credential).toBeNull();
    await sendDelivery(partial, 404, true, randomUUID());
    await migration`UPDATE public.connector_jobs SET available_at = now() WHERE installation_id = ${installation} AND kind = 'cleanup'`;
    await expect
      .poll(async () =>
        (await revisions(mirror.id)).every(({ body }) => body === null),
      )
      .toBe(true);
    expect(
      connectorSourceSchema.parse(
        await json(reader.request.get(sources + "/" + share.id)),
      ).body,
    ).toBe(chosen);

    await page.goto(sourceUi + "/" + share.id);
    await page.getByRole("button", { name: "Revoke share" }).click();
    await page.getByRole("button", { name: "Confirm revoke" }).click();
    await expect(
      page.getByRole("heading", { name: "External sources" }),
    ).toBeVisible();
    await json(reader.request.get(sources + "/" + share.id), 404);
    await expect(
      runtime`SELECT credential FROM public.connector_installations`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT body FROM public.source_revisions`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT kordos_connectors.claim(${first!}, 1)`,
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await Promise.all([
      ...contexts.map((context) => context.close()),
      stopOidc(),
      migration.end(),
      runtime.end(),
      new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
});
