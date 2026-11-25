import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, cpus, platform, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { searchResponseSchema, type SearchQuery } from "@kordos/contracts";
import { setDatabaseScope } from "@kordos/db";
import { expect, test, type BrowserContext } from "@playwright/test";
import postgres from "postgres";
import { signIn, startOidcFixture } from "../e2e/oidc-fixture.js";
import {
  coverage,
  fixtureEmbedding,
  fixtureId,
  label,
  labelCount,
  mainCount,
  model,
  neighborCounts,
  projects,
  seedSearchCorpus,
  seedVersion,
} from "./search-corpus.js";

const main = fixtureId("200", 0);
const labels = Array.from({ length: labelCount }, (_, index) => label(index));
const concurrency = 10;

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function allowed(actor: number, project: number) {
  return actor === 0 || project < 2 || (actor + project) % 3 !== 0;
}

async function serveEmbeddings() {
  let calls = 0;
  let inputs = 0;
  const server = createServer(async (request, response) => {
    try {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(body).toString()) as {
        model: string;
        input: string[];
      };
      if (request.url !== "/v1/embeddings" || payload.model !== model)
        throw new Error("Unexpected embedding request");
      const data = payload.input.map((input, index) => ({
        index,
        embedding: fixtureEmbedding(input),
      }));
      calls++;
      inputs += data.length;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data }));
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
    usage: () => ({ calls, inputs }),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("measure ranked retrieval and verify access at release scale", async ({
  browser,
  baseURL,
}, info) => {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  const logPath = process.env.KORDOS_RELEASE_SERVER_LOG;
  if (!baseURL || !ownerUrl || !appUrl || !logPath)
    throw new Error(
      "Run the release benchmark with the isolated stack environment.",
    );
  for (const url of [baseURL, ownerUrl, appUrl]) {
    if (new URL(url).hostname !== "127.0.0.1")
      throw new Error("The release fixture requires a loopback stack.");
  }
  const sql = postgres(ownerUrl, { max: 1 });
  const scoped = postgres(appUrl, { max: 2 });
  const accounts = Object.fromEntries(
    Array.from({ length: concurrency }, (_, index) => [
      `release-${index}`,
      {
        name: `Release user ${index}`,
        email: `release-${index}@example.test`,
        email_verified: true,
      },
    ]),
  );
  const closeOidc = await startOidcFixture(accounts, baseURL);
  const fixture = await serveEmbeddings();
  const sessions: BrowserContext[] = [];
  try {
    const users: string[] = [];
    const cookies: string[] = [];
    for (const account of Object.values(accounts)) {
      const context = await browser.newContext({ baseURL });
      sessions.push(context);
      const page = await context.newPage();
      await signIn(page, account, "/");
      await expect(page.getByLabel("Workspace name")).toBeVisible();
      const { identity } = await (
        await context.request.get("/api/session")
      ).json();
      expect(identity.id).toMatch(/^[0-9a-f-]{36}$/);
      users.push(identity.id);
      cookies.push(
        (await context.cookies())
          .map(({ name, value }) => `${name}=${value}`)
          .join("; "),
      );
      await page.close();
    }

    const indexStart = performance.now();
    const resumed = process.env.RELEASE_RESUME_INDEX === "1";
    const mode = process.env.RELEASE_DIAGNOSTICS ?? "full";
    if (!["full", "ranking", "access"].includes(mode))
      throw new Error(
        "Expected RELEASE_DIAGNOSTICS to be full, ranking or access.",
      );
    const diagnosticsOnly = mode !== "full";
    if (diagnosticsOnly && !resumed)
      throw new Error(
        "Diagnostics require the existing isolated release corpus.",
      );
    if (resumed) {
      const rows =
        await sql`SELECT user_id FROM public.memberships WHERE workspace_id = ${main} AND removed_at IS NULL`;
      expect(rows.map(({ user_id }) => user_id).sort()).toEqual(
        [...users].sort(),
      );
      const [membership] =
        await sql`SELECT version, removed_at FROM public.project_members
        WHERE (workspace_id, project_id, user_id) = (${main}, ${projects[3]!}, ${users[1]!})`;
      expect(membership).toMatchObject({ version: 1, removed_at: null });
    } else {
      await seedSearchCorpus(sql, users);
    }
    const totalSources =
      mainCount + neighborCounts.reduce((sum, count) => sum + count, 0);
    await expect
      .poll(
        async () => {
          const [pending] =
            await sql`SELECT count(*)::int AS count FROM public.search_outbox`;
          return pending?.count;
        },
        { timeout: 600_000, intervals: [2000, 5000] },
      )
      .toBe(0);
    const [loaded] =
      process.env.RELEASE_WORKER_EMBEDDINGS === "1"
        ? []
        : await sql.file(
            fileURLToPath(new URL("./seed-vectors.sql", import.meta.url)),
          );
    await expect
      .poll(
        async () => {
          const [pending] =
            await sql`SELECT count(*)::int AS count FROM public.search_chunks WHERE model IS DISTINCT FROM ${model}`;
          return pending?.count;
        },
        { timeout: 600_000, intervals: [2000, 5000] },
      )
      .toBe(0);
    const indexMs = Math.round(performance.now() - indexStart);
    const counts = await coverage(sql);
    expect(counts.reduce((sum, row) => sum + row.sources, 0)).toBe(
      totalSources,
    );
    expect(
      counts
        .filter((row) => row.workspace === main)
        .reduce((sum, row) => sum + row.indexed, 0),
    ).toBe(mainCount);
    for (const row of counts) {
      expect(row.indexed).toBe(row.sources);
      expect(row.embedded).toBe(row.chunks);
    }
    const [vectors] = await sql<
      { count: number }[]
    >`SELECT count(*)::int FROM public.search_vectors`;
    expect(vectors?.count).toBe(
      counts.reduce((sum, row) => sum + row.embedded, 0),
    );
    await sql`ANALYZE public.search_chunks`;
    await sql`ANALYZE public.search_vectors`;
    await sql`ANALYZE public.search_outbox`;
    const indexingProvider = fixture.usage();

    const origin = `http://127.0.0.1:${process.env.API_PORT ?? 4301}`;
    async function search(
      actor: number,
      workspace: string,
      input: SearchQuery,
    ) {
      const url = new URL(`/api/workspaces/${workspace}/search`, origin);
      for (const [key, value] of Object.entries(input))
        url.searchParams.set(key, value);
      const start = performance.now();
      const response = await fetch(url, {
        headers: { cookie: cookies[actor]! },
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      const ms = Math.round(performance.now() - start);
      return {
        ms,
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        result: response.ok ? searchResponseSchema.parse(body) : null,
      };
    }

    const attempts: {
      phase: "cold" | "warm";
      actor: number;
      label: number;
      mode: ReturnType<typeof label>["mode"];
      status: number;
      resultMode: string | null;
      requestId: string | null;
      ms: number;
      forbidden: number;
    }[] = [];
    const eligible = users.map((_, actor) =>
      labels.filter((l) => allowed(actor, l.project)),
    );
    const phases: {
      phase: string;
      batch: number;
      calls: number;
      eligible: number;
    }[] = [];
    for (let batch = 0; batch < (diagnosticsOnly ? 0 : 5); batch++) {
      for (const phase of ["cold", "warm"] as const) {
        const before = fixture.usage().calls;
        const start = attempts.length;
        await Promise.all(
          users.map(async (_, actor) => {
            const available = eligible[actor]!;
            for (let offset = 0; offset < 10; offset++) {
              const index =
                (actor * 7 + batch * 10 + offset) % available.length;
              const entry = available[index]!;
              const input: SearchQuery = { q: entry.q };
              if ((index + actor) % 3 === 0)
                input.project = projects[entry.project];
              if ((index + actor) % 4 === 0) input.type = entry.kind;
              if ((index + actor) % 5 === 0) input.owner = users[0];
              const response = await search(actor, main, input).catch(() => ({
                ms: 15_000,
                status: 0,
                requestId: null,
                result: null,
              }));
              const forbidden = (response.result?.items ?? []).filter(
                ({ id, projectId }) =>
                  !id.startsWith("22000000-0000-4000-8001-") ||
                  !projects.some(
                    (project, index) =>
                      project === projectId && allowed(actor, index),
                  ),
              ).length;
              attempts.push({
                phase,
                actor,
                label: entry.index,
                mode: entry.mode,
                status: response.status,
                resultMode: response.result?.mode ?? null,
                requestId: response.requestId,
                ms: response.ms,
                forbidden,
              });
            }
          }),
        );
        phases.push({
          phase,
          batch,
          calls: fixture.usage().calls - before,
          eligible: attempts.slice(start).filter(({ mode }) => mode !== "exact")
            .length,
        });
      }
    }
    const requestLogs = new Map<string, number>();
    for (const line of (await readFile(logPath, "utf8")).split("\n")) {
      const start = line.indexOf('{"level":');
      if (start < 0) continue;
      try {
        const log = JSON.parse(line.slice(start));
        if (
          log.event === "http.request" &&
          log.route === "/api/workspaces/:workspaceId/search"
        )
          requestLogs.set(log.reqId, log.durationMs);
      } catch {
        // Concurrent process output may interleave individual log records.
      }
    }
    const samples = attempts.map((attempt) => ({
      ...attempt,
      ingressMs: requestLogs.get(attempt.requestId ?? "") ?? null,
    }));
    function summarize(subset: typeof samples) {
      const successful = subset.filter(({ status }) => status === 200);
      const ingress = successful.flatMap(({ ingressMs }) =>
        ingressMs === null ? [] : [ingressMs],
      );
      return {
        requested: subset.length,
        succeeded: successful.length,
        statusCounts: Object.fromEntries(
          [...new Set(subset.map(({ status }) => status))].map((status) => [
            status,
            subset.filter((sample) => sample.status === status).length,
          ]),
        ),
        ingressCount: ingress.length,
        rankedWithinOneSecond: ingress.filter((ms) => ms < 1000).length,
        ingressMs: percentiles(ingress),
        loopbackMs: percentiles(successful.map(({ ms }) => ms)),
        hybridFallbacks: successful.filter(
          ({ mode, resultMode }) => mode !== "exact" && resultMode !== "hybrid",
        ).length,
      };
    }

    await info.attach("search-samples", {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });

    const relevance: {
      expected: string;
      query: string;
      mode: string;
      combined: string[];
      lexical: string[];
      vector: string[];
    }[] = [];
    for (const entry of mode === "access" ? [] : labels) {
      const { id, q, mode } = entry;
      const combined = diagnosticsOnly
        ? null
        : (await search(0, main, { q })).result;
      const exact = mode === "exact" ? q : null;
      const [lexical, vector, ranked] = await scoped.begin(async (tx) => {
        await setDatabaseScope(tx, users[0]!, main);
        await tx`SET LOCAL jit = off`;
        const [text] = await tx`
          SELECT kordos_search.query(${JSON.stringify({ q })}::text::jsonb, ${exact}, null, null) AS result
        `;
        const [semantic] = await tx`
          SELECT kordos_search.query('{"q":"zzzxnovocabularymatch"}'::jsonb, null, ${model},
            ${JSON.stringify(fixtureEmbedding(q))}::public.vector) AS result
        `;
        const [diagnostic] =
          diagnosticsOnly && exact === null
            ? await tx`
              SELECT kordos_search.query(${JSON.stringify({ q })}::text::jsonb, null, ${model},
                ${JSON.stringify(fixtureEmbedding(q))}::public.vector) AS result
            `
            : [];
        return [
          searchResponseSchema.parse(text?.result),
          searchResponseSchema.parse(semantic?.result),
          diagnosticsOnly
            ? searchResponseSchema.parse(diagnostic?.result ?? text?.result)
            : combined,
        ];
      });
      relevance.push({
        expected: id,
        query: q,
        mode,
        combined: ranked?.items.slice(0, 5).map((item) => item.id) ?? [],
        lexical: lexical.items.slice(0, 5).map((item) => item.id),
        vector: vector.items.slice(0, 5).map((item) => item.id),
      });
    }
    const hits = Object.fromEntries(
      (["combined", "lexical", "vector"] as const).map((mode) => [
        mode,
        relevance.filter((row) => row[mode].includes(row.expected)).length,
      ]),
    );

    await info.attach("relevance-labels", {
      body: JSON.stringify(relevance, null, 2),
      contentType: "application/json",
    });

    const probes: { name: string; passed: boolean }[] = [];
    const restricted = label(39);
    const restrictedProject = projects[restricted.project]!;
    const neighbor = fixtureId("200", 1);
    const path = `/api/workspaces/${main}/projects/${restrictedProject}`;
    const viewer = sessions[1]!.request;
    const neighborOwn = await search(1, neighbor, { q: restricted.q });
    probes.push({
      name: "neighbor same vocabulary remains in its own tenant",
      passed:
        neighborOwn.status === 200 &&
        (neighborOwn.result?.items ?? []).length > 0 &&
        neighborOwn.result!.items.every(
          ({ projectId }) => projectId === fixtureId("101", 1),
        ),
    });
    probes.push({
      name: "foreign tenant search",
      passed: (await search(0, neighbor, { q: restricted.q })).status === 404,
    });
    probes.push({
      name: "ungranted restricted project",
      passed:
        (await search(1, main, { q: label(38).q, project: projects[2] }))
          .status === 404,
    });
    const warm = await search(1, main, {
      q: restricted.q,
      project: restrictedProject,
    });
    probes.push({
      name: "authorized restricted search before revocation",
      passed:
        warm.result?.items.some(({ id }) => id === restricted.id) ?? false,
    });
    const mutation = await sessions[0]!.request.patch(
      `${path}/members/${users[1]}`,
      {
        headers: { Origin: baseURL },
        data: { role: null, expectedVersion: 1, mutationId: randomUUID() },
      },
    );
    probes.push({
      name: "lead revokes project access",
      passed: mutation.status() === 200,
    });
    const after = await search(1, main, {
      q: restricted.q,
      project: restrictedProject,
    });
    probes.push({
      name: "warmed project filter after project member revocation",
      passed: after.status === 404,
    });
    const workspaceAfter = await search(1, main, { q: restricted.q });
    probes.push({
      name: "warmed workspace search after project member revocation",
      passed:
        workspaceAfter.status === 200 &&
        (workspaceAfter.result?.items.every(
          ({ projectId }) => projectId !== restrictedProject,
        ) ??
          false),
    });
    const exactAfter = await search(1, main, { q: restricted.id });
    probes.push({
      name: "workspace exact ID search after revocation",
      passed:
        exactAfter.status === 200 && exactAfter.result?.items.length === 0,
    });
    probes.push({
      name: "direct read after revocation",
      passed: (await viewer.get(path)).status() === 404,
    });
    probes.push({
      name: "write after revocation",
      passed:
        (
          await viewer.patch(path, {
            headers: { Origin: baseURL },
            data: {
              action: "archive",
              expectedVersion: 1,
              mutationId: randomUUID(),
            },
          })
        ).status() === 404,
    });
    const [project] =
      await sql`SELECT version, archived_at FROM public.projects WHERE id = ${restrictedProject}`;
    probes.push({
      name: "canonical project unchanged",
      passed: project?.version === 1 && project?.archived_at === null,
    });

    const [versions] = await sql`SELECT version() AS postgres,
      (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector,
      (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS applied_migrations`;
    const summary = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      worktreeTrackedChanges: execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=no"],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean),
      seed: seedVersion,
      diagnostics: mode,
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
        ...versions,
      },
      model,
      concurrency,
      counts,
      indexMs,
      resumedIndex: resumed,
      bulkFixtureVectors: loaded?.chunks ?? 0,
      indexingProvider,
      providerCostUsd: 0,
      all: summarize(samples),
      cold: summarize(samples.filter(({ phase }) => phase === "cold")),
      warm: summarize(samples.filter(({ phase }) => phase === "warm")),
      phases,
      hits,
      probes,
      forbiddenOutputs: samples.reduce(
        (sum, sample) => sum + sample.forbidden,
        0,
      ),
    };
    await info.attach("search-summary", {
      body: JSON.stringify(summary, null, 2),
      contentType: "application/json",
    });
    console.log(JSON.stringify(summary));

    expect(samples).toHaveLength(diagnosticsOnly ? 0 : 1000);
    expect(summary.forbiddenOutputs).toBe(0);
    expect(probes.filter(({ passed }) => !passed)).toEqual([]);
    if (mode !== "access")
      expect.soft(hits.combined).toBeGreaterThanOrEqual(85);
    const rankedWithinTarget = samples.filter(
      ({ status, ingressMs }) =>
        status === 200 && ingressMs !== null && ingressMs < 1000,
    ).length;
    if (!diagnosticsOnly)
      expect(rankedWithinTarget).toBeGreaterThanOrEqual(950);
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await Promise.all([sql.end(), scoped.end(), closeOidc(), fixture.close()]);
  }
});
