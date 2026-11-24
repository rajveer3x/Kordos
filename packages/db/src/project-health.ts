import { duplicateReviewSchema, type DuplicateAction } from "@kordos/contracts";
import { sharedDeliverableTerms, weeklySchedule } from "@kordos/domain";
import postgres, { type Sql } from "postgres";
import { readSchedule } from "./forecast.js";
import { databaseScope, setDatabaseScope } from "./identity.js";

type Scope = [actor: string, workspace: string];

export function projectHealthStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    reports([actor, workspace]: Scope, project: string, period: string | null) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_health.reports(${project},${period}::text::date) AS value`;
        return row?.value;
      });
    },
    duplicates([actor, workspace]: Scope, project: string, work: string) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_health.duplicates(${project},${work}) AS value`;
        if (!row?.value) return;
        const result = duplicateReviewSchema
          .extend({
            candidates: duplicateReviewSchema.shape.candidates.element
              .omit({ sharedTerms: true })
              .array(),
          })
          .parse(row.value);
        const deliverable = (task: typeof result.task) =>
          `${task.title} ${task.description ?? ""}`;
        return {
          ...result,
          candidates: result.candidates.map((candidate) => ({
            ...candidate,
            sharedTerms: sharedDeliverableTerms(
              deliverable(result.task),
              deliverable(candidate),
            ),
          })),
        };
      });
    },
    act(
      [actor, workspace]: Scope,
      project: string,
      work: string,
      input: DuplicateAction,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ value: { result: string } }[]>`
          SELECT kordos_health.pair_action(${project},${work},${JSON.stringify(input)}::text::jsonb) AS value
        `;
        return row!.value;
      });
    },
  };
}

export function connectHealthWorker(url: string) {
  const client = postgres(url, {
    max: 1,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  return {
    captureNext: () =>
      client.begin(async (sql) => {
        const [job] = await sql<
          { workspace: string; project: string; actor: string }[]
        >`
          SELECT * FROM kordos_health.next_project()
        `;
        if (!job) return false;
        const { workspace, project, actor } = job;
        await setDatabaseScope(sql, actor, workspace);
        const schedule = await readSchedule(sql, workspace, project);
        if (schedule && !schedule.archived) {
          const snapshot = weeklySchedule(schedule);
          await sql`SELECT kordos_health.save_report(${project},${JSON.stringify(snapshot)}::text::jsonb)`;
        }
        return true;
      }),
    close: () => client.end({ timeout: 3 }),
  };
}
