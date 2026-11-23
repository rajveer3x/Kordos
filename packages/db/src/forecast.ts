import type {
  CreateScenario,
  Dependency,
  DependencyChange,
  ProjectGraph,
  Scenario,
} from "@kordos/contracts";
import {
  businessDate,
  calculateForecast,
  compareScenario,
  dependencyPath,
} from "@kordos/domain";
import type { Sql, TransactionSql } from "postgres";
import { databaseScope } from "./identity.js";

type Scope = [actor: string, workspace: string];
type Snapshot = Omit<ProjectGraph, "forecast"> & { archived: boolean };
type DependencyResult =
  | { result: "saved"; id: string }
  | { result: "conflict"; graphVersion: number }
  | { result: "cycle"; path: { id: string; title: string }[] }
  | { result: "unavailable" | "invalid_state" | "mutation_conflict" };

async function readSchedule(
  sql: TransactionSql,
  workspace: string,
  project: string,
) {
  // One statement keeps the topology, work revisions and calendar on the same snapshot.
  const [row] = await sql<
    (Omit<Snapshot, "asOf"> & { readAtMillis: number })[]
  >`
    WITH items AS MATERIALIZED (
      SELECT id, title, kind, status, version, estimate_days, commitment, completed_at, owner_id
      FROM public.work_items
      WHERE workspace_id = ${workspace} AND project_id = ${project} AND archived_at IS NULL
    )
    SELECT p.graph_version AS "graphVersion", p.archived_at IS NOT NULL AS archived,
      (extract(epoch FROM statement_timestamp()) * 1000)::float8 AS "readAtMillis",
      encode(sha256(convert_to(jsonb_build_array(p.id, p.version, p.graph_version, work.revisions)::text, 'UTF8')), 'hex')
        AS "inputRevision",
      jsonb_build_object(
        'timeZone', p.time_zone, 'workdays', p.workdays, 'nonworkingDates', p.nonworking_dates
      ) AS calendar,
      coalesce(work.items, '[]'::jsonb) AS items,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object('predecessorId', e.predecessor_id, 'successorId', e.successor_id)
          ORDER BY e.predecessor_id, e.successor_id)
        FROM public.dependency_edges e JOIN items a ON a.id = e.predecessor_id JOIN items b ON b.id = e.successor_id
        WHERE e.workspace_id = p.workspace_id AND e.project_id = p.id
      ), '[]'::jsonb) AS edges
    FROM public.projects p
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'title', i.title, 'kind', i.kind, 'status', i.status, 'version', i.version,
        'estimateDays', i.estimate_days, 'commitment', i.commitment,
        'completedAt', to_char(i.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'owner', kordos_planning.person(p.id, i.owner_id)
      ) ORDER BY i.title, i.id) AS items,
      jsonb_agg(jsonb_build_array(i.id, i.version) ORDER BY i.id) AS revisions
      FROM items i
    ) work
    WHERE p.workspace_id = ${workspace} AND p.id = ${project}
  `;
  if (!row) return;
  const { readAtMillis, ...snapshot } = row;
  return {
    ...snapshot,
    asOf: businessDate(snapshot.calendar.timeZone, new Date(readAtMillis)),
  };
}

async function conflictingPath(
  sql: TransactionSql,
  workspace: string,
  project: string,
  { predecessorId, successorId }: Dependency,
) {
  const edges = await sql<Dependency[]>`
    SELECT predecessor_id AS "predecessorId", successor_id AS "successorId"
    FROM public.dependency_edges WHERE workspace_id = ${workspace} AND project_id = ${project}
    ORDER BY predecessor_id, successor_id
  `;
  const ids = [
    predecessorId,
    ...dependencyPath(edges, successorId, predecessorId)!,
  ];
  const work = await sql<{ id: string; title: string }[]>`
    SELECT id, title FROM public.work_items
    WHERE workspace_id = ${workspace} AND project_id = ${project} AND id = ANY(${ids}::uuid[])
  `;
  const titles = new Map(work.map(({ id, title }) => [id, title]));
  return ids.map((id) => ({ id, title: titles.get(id)! }));
}

type StoredScenario = {
  id: string;
  request: CreateScenario;
  comparison: Omit<Scenario, "id" | "inputRevision" | "asOf" | "changes">;
};

function scenarioDto({ id, request, comparison }: StoredScenario): Scenario {
  const { inputRevision, asOf, changes } = request;
  return { id, inputRevision, asOf, changes, ...comparison };
}

export function forecastStore(client: Sql) {
  const scoped = databaseScope(client);

  return {
    graph([actor, workspace]: Scope, project: string) {
      return scoped(actor, workspace, async (sql) => {
        const snapshot = await readSchedule(sql, workspace, project);
        if (snapshot)
          return { ...snapshot, forecast: calculateForecast(snapshot) };
      });
    },
    changeDependency(
      [actor, workspace]: Scope,
      project: string,
      input: DependencyChange,
    ): Promise<DependencyResult> {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ command: DependencyResult }[]>`
          SELECT kordos_planning.save_dependency(${project}, ${JSON.stringify(input)}::jsonb) AS command
        `;
        const { command } = row!;
        if (command.result !== "cycle") return command;
        return {
          result: "cycle",
          path: await conflictingPath(sql, workspace, project, input),
        };
      });
    },
    createScenario(
      [actor, workspace]: Scope,
      project: string,
      input: CreateScenario,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [lock] = await sql<{ acquired: boolean }[]>`
          SELECT kordos_planning.lock_schedule(${project}, ${input.mutationId}) AS acquired
        `;
        if (!lock?.acquired) return { result: "unavailable" } as const;
        const [previous] = await sql<(StoredScenario & { same: boolean })[]>`
          SELECT id, request, comparison, request = ${JSON.stringify(input)}::jsonb AND project_id = ${project} AS same
          FROM public.scenarios
          WHERE workspace_id = ${workspace} AND actor_id = ${actor}
            AND mutation_id = ${input.mutationId}
        `;
        if (previous) {
          return previous.same
            ? ({ result: "saved", scenario: scenarioDto(previous) } as const)
            : ({ result: "mutation_conflict" } as const);
        }
        const schedule = await readSchedule(sql, workspace, project);
        if (!schedule) return { result: "unavailable" } as const;
        if (schedule.archived) return { result: "invalid_state" } as const;
        const { inputRevision, asOf } = schedule;
        if (input.inputRevision !== inputRevision || input.asOf !== asOf) {
          return {
            result: "conflict",
            current: { inputRevision, asOf },
          } as const;
        }
        const items = new Map(schedule.items.map((item) => [item.id, item]));
        for (const change of input.changes) {
          const item = items.get(change.workId);
          if (!item) return { result: "unavailable" } as const;
          if (item.completedAt || item.kind !== "task")
            return { result: "invalid_state" } as const;
          if (change.kind === "handoff" && change.finish < asOf) {
            return { result: "past_handoff" } as const;
          }
        }
        const comparison = {
          version: 1,
          ...compareScenario(schedule, input.changes),
        };
        const [saved] = await sql<StoredScenario[]>`
          INSERT INTO public.scenarios (workspace_id, project_id, actor_id, mutation_id, request, comparison)
          VALUES (${workspace}, ${project}, ${actor}, ${input.mutationId},
            ${JSON.stringify(input)}::jsonb, ${JSON.stringify(comparison)}::jsonb)
          ON CONFLICT ON CONSTRAINT scenarios_actor_mutation DO NOTHING
          RETURNING id, request, comparison
        `;
        if (!saved) return { result: "mutation_conflict" } as const;
        return { result: "saved", scenario: scenarioDto(saved) } as const;
      });
    },
    scenario([actor, workspace]: Scope, project: string, id: string) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<StoredScenario[]>`
          SELECT id, request, comparison FROM public.scenarios
          WHERE workspace_id = ${workspace} AND project_id = ${project} AND id = ${id}
        `;
        if (row) return scenarioDto(row);
      });
    },
    discard([actor, workspace]: Scope, project: string, id: string) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql`
          DELETE FROM public.scenarios
          WHERE workspace_id = ${workspace} AND project_id = ${project} AND id = ${id} RETURNING id
        `;
        return !!row;
      });
    },
  };
}
