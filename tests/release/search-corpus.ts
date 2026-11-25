import { searchEmbeddingDimensions, type SearchQuery } from "@kordos/contracts";
import type { Sql } from "postgres";

export const seedVersion = "kordos-release-22-v1";
export const model = "search-embeddings-fixture";
export const mainCount = 100_000;
export const neighborCounts = [2048, 1024, 768, 512, 384, 256, 192, 128, 128];
export const labelCount = 100;

const topics = [
  ["checkout migration", "move the payment flow"],
  ["replica failover", "recover after the database primary goes down"],
  ["launch readiness", "are we ready to go live"],
  ["retention compliance", "how long do we keep records"],
  ["incident handover", "pass the outage to the next shift"],
] as const;

export function fixtureId(namespace: string, index: number) {
  return `22000000-0000-4000-8${namespace.padStart(3, "0")}-${index.toString(16).padStart(12, "0")}`;
}

export function label(index: number) {
  const topic = topics[index % topics.length]!;
  const group = String(index).padStart(3, "0");
  const kind: SearchQuery["type"] =
    index % 10 < 7 ? "work" : index % 10 < 9 ? "document" : "meeting";
  const mode = (
    ["exact", "paraphrase", "keyword", "keyword", "paraphrase"] as const
  )[Math.floor(index / 5) % 5]!;
  const id = fixtureId("001", index);
  const q =
    mode === "exact"
      ? id
      : mode === "paraphrase"
        ? `${topic[1]} for rotation cohort r${group}`
        : `${topic[0]} dossier b${group}`;
  return { index, id, kind, mode, q, project: index % 12 };
}

export function fixtureEmbedding(input: string) {
  const values = Array<number>(searchEmbeddingDimensions).fill(0);
  const number = /\b(?:dossier b|cohort r)(\d+)\b/.exec(input)?.[1];
  const dimension = number
    ? Number(number) % 100
    : 100 + (Number(/\brecord (\d+)\b/.exec(input)?.[1] ?? 0) % 412);
  values[dimension] = 1;
  return values;
}

export const projects = Array.from({ length: 12 }, (_, index) =>
  fixtureId("100", index),
);

export async function seedSearchCorpus(sql: Sql, users: string[]) {
  await sql.begin(async (tx) => {
    const [dirty] =
      await tx`SELECT EXISTS (SELECT FROM public.workspaces) AS present`;
    if (dirty?.present)
      throw new Error("Use a fresh, migrated release benchmark database.");
    await tx`
      CREATE TEMP TABLE release_sources (
        tenant int, idx int, id uuid, workspace uuid, project uuid, owner_id uuid,
        kind text, title text, body text
      ) ON COMMIT DROP
    `;
    for (const [tenant, count] of [mainCount, ...neighborCounts].entries()) {
      const workspace = fixtureId("200", tenant);
      const owner = users[tenant]!;
      await tx`
        INSERT INTO public.workspaces (id, name, time_zone, created_by)
        VALUES (${workspace}, 'Launch program', 'UTC', ${owner})
      `;
      const members = tenant === 0 ? users : [owner];
      await tx`INSERT INTO public.memberships ${tx(
        members.map((user_id) => ({
          workspace_id: workspace,
          user_id,
          role: user_id === owner ? "admin" : "contributor",
        })),
      )}`;
      const ids = tenant === 0 ? projects : [fixtureId("101", tenant)];
      await tx`INSERT INTO public.projects ${tx(
        ids.map((id, index) => ({
          id,
          workspace_id: workspace,
          name: index % 2 === 0 ? "Launch" : "Launch support",
          visibility: index < 2 ? "workspace" : "restricted",
        })),
      )}`;
      await tx`INSERT INTO public.project_members ${tx(
        ids.flatMap((project_id, index) =>
          members
            .filter(
              (_, user) => user === 0 || index < 2 || (index + user) % 3 !== 0,
            )
            .map((user_id) => ({
              workspace_id: workspace,
              project_id,
              user_id,
              role: user_id === owner ? "lead" : "contributor",
            })),
        ),
      )}`;
      await tx`
        INSERT INTO release_sources
        SELECT ${tenant}, n,
          ('22000000-0000-4000-8' || lpad((${tenant}::int + 1)::text, 3, '0') ||
            '-' || lpad(to_hex(n), 12, '0'))::uuid,
          ${workspace}::uuid,
          (${tx.array(ids)}::uuid[])[CASE WHEN ${tenant}::int <> 0 THEN 1
            WHEN n < 100 OR n % 4 = 0 THEN (n % 12) + 1
            ELSE (n % 2) + 1 END],
          ${owner}::uuid,
          CASE WHEN n % 10 < 7 THEN 'work' WHEN n % 10 < 9 THEN 'document' ELSE 'meeting' END,
          (${tx.array(topics.map(([name]) => name))}::text[])[n % 5 + 1] ||
            CASE WHEN n < 100 THEN ' dossier b' || lpad(n::text, 3, '0')
              ELSE ' record ' || n::text END,
          CASE WHEN n % 10 IN (7, 8) THEN
            repeat('Release reviewers compared the planned milestones and validated access to the deployment checklist. ', 8)
            ELSE 'Release reviewers validated access to the deployment checklist.' END
        FROM generate_series(0, ${count - 1}::int) AS n
      `;
    }
    await tx`
      INSERT INTO public.work_items (id, workspace_id, project_id, title, description, kind, status, owner_id)
      SELECT id, workspace, project, title, body, 'task', 'ready', owner_id
      FROM release_sources WHERE kind = 'work'
    `;
    await tx`
      INSERT INTO public.documents (id, workspace_id, project_id)
      SELECT id, workspace, project FROM release_sources WHERE kind = 'document'
    `;
    await tx`
      INSERT INTO public.document_versions (workspace_id, project_id, document_id, revision, title, content, author_id)
      SELECT workspace, project, id, 1, title, body, owner_id FROM release_sources WHERE kind = 'document'
    `;
    await tx`
      INSERT INTO public.meetings
        (id, workspace_id, project_id, organizer_id, job_actor_id, title, agenda, starts_at, time_zone, retention_days)
      SELECT id, workspace, project, owner_id, owner_id, title, body, '2026-01-15T09:00:00Z', 'UTC', 90
      FROM release_sources WHERE kind = 'meeting'
    `;
  });
}

export async function coverage(sql: Sql) {
  return sql`
    SELECT s.workspace_id AS workspace, s.kind,
      count(*)::int AS sources,
      count(c.source_id)::int AS indexed,
      coalesce(sum(c.chunks), 0)::int AS chunks,
      coalesce(sum(c.embedded), 0)::int AS embedded
    FROM kordos_search.sources s
    LEFT JOIN (
      SELECT workspace_id, project_id, kind, source_id, revision, count(*) AS chunks,
        count(*) FILTER (WHERE model = ${model} AND embedding IS NOT NULL) AS embedded
      FROM public.search_chunks GROUP BY 1, 2, 3, 4, 5
    ) c USING (workspace_id, project_id, kind, source_id, revision)
    GROUP BY s.workspace_id, s.kind ORDER BY s.workspace_id, s.kind
  `;
}
