import type {
  BriefFailure,
  BriefPlan,
  BriefWorkerJob,
  createBriefSchema,
  retryBriefSchema,
} from "@kordos/contracts";
import postgres, { type Sql } from "postgres";
import type { z } from "zod";
import { databaseScope } from "./identity.js";

type Scope = [actor: string, workspace: string];

export function briefsStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    list([actor, workspace]: Scope, project: string, cursor: string | null) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_briefs.directory(${project}, ${cursor}) AS value`;
        return row?.value;
      });
    },
    detail([actor, workspace]: Scope, project: string, id: string) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_briefs.detail(${project}, ${id}) AS value`;
        return row?.value;
      });
    },
    origin([actor, workspace]: Scope, project: string, work: string) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_briefs.work_origin(${project}, ${work}) AS value`;
        return row?.value;
      });
    },
    create(
      [actor, workspace]: Scope,
      project: string,
      input: z.infer<typeof createBriefSchema>,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ value: { result: string } }[]>`
          SELECT kordos_briefs.create_job(${project}, ${JSON.stringify(input)}::text::jsonb) AS value
        `;
        return row!.value;
      });
    },
    retry(
      [actor, workspace]: Scope,
      project: string,
      id: string,
      input: z.infer<typeof retryBriefSchema>,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ value: { result: string } }[]>`
          SELECT kordos_briefs.retry(${project}, ${id}, ${JSON.stringify(input)}::text::jsonb) AS value
        `;
        return row!.value;
      });
    },
  };
}

export function connectBriefWorker(url: string) {
  const sql = postgres(url, {
    connect_timeout: 2,
    connection: { statement_timeout: 1500 },
  });
  return {
    pending: () => sql<BriefWorkerJob[]>`SELECT * FROM kordos_briefs.pending()`,
    async claim({ id, attempt }: BriefWorkerJob) {
      const [row] =
        await sql`SELECT kordos_briefs.claim(${id}, ${attempt}) AS value`;
      return row?.value;
    },
    async finish(
      id: string,
      leaseId: string,
      outcome: { plan: BriefPlan } | { failure: BriefFailure },
    ) {
      await sql`SELECT kordos_briefs.finish(${id}, ${leaseId},
        ${"plan" in outcome ? JSON.stringify(outcome.plan) : null}::text::jsonb,
        ${"failure" in outcome ? outcome.failure : null})`;
    },
    close: () => sql.end({ timeout: 3 }),
  };
}
