import type {
  ChangeProjectMember,
  CreateProject,
  CreateWork,
  ProjectDetails,
  ProjectPeople,
  UpdateProject,
  UpdateWork,
  WorkFilter,
  WorkHistory,
  WorkItem,
} from "@kordos/contracts";
import type { Sql, TransactionSql } from "postgres";
import { databaseScope } from "./identity.js";

type Scope = [actor: string, workspace: string];
type CommandResult =
  | { result: "saved"; id: string }
  | {
      result:
        | "unavailable"
        | "conflict"
        | "mutation_conflict"
        | "invalid_state"
        | "commitment_requires_lead"
        | "invalid_owner"
        | "invalid_role"
        | "last_lead";
    };

const pageSize = 60;

async function readProject(sql: TransactionSql, workspace: string, id: string) {
  const [project] = await sql<ProjectDetails[]>`
    SELECT p.id, p.name, p.description, p.visibility, p.time_zone AS "timeZone", p.workdays,
      ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(p.nonworking_dates) d) AS "nonworkingDates",
      p.version, p.archived_at IS NOT NULL AS archived,
      kordos_planning.project_access(p.id) AS role, kordos_planning.lead(p.id) AS lead,
      rollup.commitment, rollup."activeCount"
    FROM public.projects p
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS "activeCount", to_char(min(w.commitment), 'YYYY-MM-DD') AS commitment
      FROM public.work_items w WHERE w.workspace_id = p.workspace_id AND w.project_id = p.id
        AND p.archived_at IS NULL AND w.archived_at IS NULL AND w.status <> 'done'
    ) rollup
    WHERE p.workspace_id = ${workspace} AND p.id = ${id}
  `;
  return project;
}

function workProjection(sql: TransactionSql) {
  return sql`
    kordos_planning.work_snapshot(w) || jsonb_build_object(
      'id', w.id, 'projectId', w.project_id, 'projectName', p.name,
      'owner', kordos_planning.person(w.project_id, w.owner_id),
      'blockerOwner', kordos_planning.person(w.project_id, w.blocker_owner_id)
    ) AS item
  `;
}

async function readWork(
  sql: TransactionSql,
  workspace: string,
  project: string,
  id: string,
) {
  const [row] = await sql<{ item: WorkItem }[]>`
    SELECT ${workProjection(sql)} FROM public.work_items w
    JOIN public.projects p ON p.workspace_id = w.workspace_id AND p.id = w.project_id
    WHERE w.workspace_id = ${workspace} AND w.project_id = ${project} AND w.id = ${id}
  `;
  return row?.item;
}

async function readPeople(sql: TransactionSql, project: string) {
  const [row] = await sql<{ people: ProjectPeople | null }[]>`
    SELECT kordos_planning.people(${project}) AS people
  `;
  return row?.people;
}

function page<T>(items: T[], cursor: (last: T) => string) {
  return {
    items: items.slice(0, pageSize),
    nextCursor: items.length > pageSize ? cursor(items[pageSize - 1]!) : null,
  };
}

export function planningStore(client: Sql) {
  const scoped = databaseScope(client);

  return {
    audience([actor, workspace]: Scope) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ count: number | null }[]>`
          SELECT kordos_planning.audience() AS count
        `;
        return row?.count;
      });
    },
    project([actor, workspace]: Scope, project: string) {
      return scoped(actor, workspace, (sql) =>
        readProject(sql, workspace, project),
      );
    },
    people([actor, workspace]: Scope, project: string) {
      return scoped(actor, workspace, (sql) => readPeople(sql, project));
    },
    saveProject(
      [actor, workspace]: Scope,
      project: string | null,
      input: CreateProject | UpdateProject,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ command: CommandResult }[]>`
          SELECT kordos_planning.save_project(${project}, ${JSON.stringify(input)}::jsonb) AS command
        `;
        const command = row!.command;
        const current =
          command.result === "conflict" && project
            ? await readProject(sql, workspace, project)
            : undefined;
        return { command, current };
      });
    },
    saveMember(
      [actor, workspace]: Scope,
      project: string,
      user: string,
      input: ChangeProjectMember,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ command: CommandResult }[]>`
          SELECT kordos_planning.save_member(${project}, ${user}, ${JSON.stringify(input)}::jsonb) AS command
        `;
        const command = row!.command;
        const current =
          command.result === "conflict"
            ? ((await readPeople(sql, project))?.members.find(
                ({ id }) => id === user,
              ) ?? null)
            : undefined;
        return { command, current };
      });
    },
    workPage(
      [actor, workspace]: Scope,
      options: {
        project?: string;
        filter?: WorkFilter;
        after?: string;
      },
    ) {
      const { project, filter, after } = options;
      return scoped(actor, workspace, async (sql) => {
        if (project) {
          const [result] = await sql<{ visible: boolean }[]>`
            SELECT kordos_planning.project_access(${project}) IS NOT NULL AS visible
          `;
          if (!result?.visible) return;
        } else {
          const [visible] =
            await sql`SELECT id FROM public.workspaces WHERE id = ${workspace}`;
          if (!visible) return;
        }
        const rows = await sql<{ item: WorkItem }[]>`
          SELECT ${workProjection(sql)} FROM public.work_items w
          JOIN public.projects p ON p.workspace_id = w.workspace_id AND p.id = w.project_id
          WHERE w.workspace_id = ${workspace}
            ${
              project
                ? sql`AND w.project_id = ${project}`
                : sql`AND w.owner_id = ${actor} AND p.archived_at IS NULL AND w.status <> 'done'
                AND kordos_planning.project_access(p.id) IN ('contributor', 'lead')`
            }
            AND (w.archived_at IS NOT NULL) = ${filter?.archived === "true"}
            ${filter?.status ? sql`AND w.status = ${filter.status}` : sql``}
            ${filter?.kind ? sql`AND w.kind = ${filter.kind}` : sql``}
            ${
              filter?.q
                ? sql`AND (strpos(lower(w.title), lower(${filter.q})) > 0
              OR strpos(lower(coalesce(w.description, '')), lower(${filter.q})) > 0)`
                : sql``
            }
            ${after ? sql`AND w.id > ${after}` : sql``}
          ORDER BY w.id LIMIT ${pageSize + 1}
        `;
        return page(
          rows.map(({ item }) => item),
          ({ id }) => id,
        );
      });
    },
    work([actor, workspace]: Scope, project: string, work: string) {
      return scoped(actor, workspace, (sql) =>
        readWork(sql, workspace, project, work),
      );
    },
    history(
      [actor, workspace]: Scope,
      project: string,
      work: string,
      before?: number,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [visible] = await sql`
          SELECT id FROM public.work_items
          WHERE workspace_id = ${workspace} AND project_id = ${project} AND id = ${work}
        `;
        if (!visible) return;
        const rows = await sql<WorkHistory["items"]>`
          SELECT id, action, kordos_planning.person(project_id, actor_id) AS actor,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
            details->'before' AS before, details->'after' AS after
          FROM public.audit_events
          WHERE workspace_id = ${workspace} AND project_id = ${project} AND target_id = ${work}
            AND action LIKE 'work.%'
            ${before ? sql`AND (details->'after'->>'version')::int < ${before}` : sql``}
          ORDER BY (details->'after'->>'version')::int DESC LIMIT ${pageSize + 1}
        `;
        return page(rows, ({ after }) => String(after.version));
      });
    },
    saveWork(
      [actor, workspace]: Scope,
      project: string,
      work: string | null,
      input: CreateWork | UpdateWork,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ command: CommandResult }[]>`
          SELECT kordos_planning.save_work(${project}, ${work}, ${JSON.stringify(input)}::jsonb) AS command
        `;
        const command = row!.command;
        const current =
          command.result === "conflict" && work
            ? await readWork(sql, workspace, project, work)
            : undefined;
        return { command, current };
      });
    },
  };
}
