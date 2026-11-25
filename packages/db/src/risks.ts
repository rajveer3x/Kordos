import {
  riskAssessmentSchema,
  riskSourceSchema,
  type RiskAction,
  type RiskJob,
  type RiskSource,
} from "@kordos/contracts";
import { assessDelay, businessDate, delayPassage } from "@kordos/domain";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { readSchedule } from "./forecast.js";
import { databaseScope } from "./identity.js";

type Scope = [actor: string, workspace: string];
const commandResult = z.object({ result: z.string() }).passthrough();
const context = z.object({
  result: z.literal("ready"),
  source: riskSourceSchema,
  priorTaskId: z.uuid().nullable(),
});

async function evaluate(
  sql: TransactionSql,
  workspace: string,
  source: RiskSource,
  task?: string,
) {
  if (!delayPassage(source.body)) return { snapshot: null, assessment: null };
  const schedule = await readSchedule(sql, workspace, source.projectId);
  if (!schedule || schedule.archived) return;
  const { calendar, inputRevision } = schedule;
  const snapshot = {
    calendar,
    inputRevision,
    asOf: businessDate(calendar.timeZone, new Date(source.capturedAt)),
  };
  const calculated = assessDelay(schedule, source, task);
  return {
    snapshot,
    assessment: calculated ? riskAssessmentSchema.parse(calculated) : null,
  };
}

export function risksStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    pending: () => client<RiskJob[]>`SELECT * FROM kordos_risks.pending()`,
    async process({ id, actor, workspace }: RiskJob) {
      const failure = await scoped(actor, workspace, async (sql) => {
        const [row] = await sql`SELECT kordos_risks.lock_job(${id}) AS value`;
        if (!row?.value) return;
        let inputRevision: string | null = null;
        return sql
          .savepoint(async (attempt) => {
            const source = riskSourceSchema.parse(row.value);
            const outcome = await evaluate(attempt, workspace, source);
            if (!outcome) throw new Error("Risk schedule was unavailable.");
            inputRevision = outcome.snapshot?.inputRevision ?? null;
            await attempt`SELECT kordos_risks.finish_job(${id}, ${JSON.stringify(outcome.snapshot)}::text::jsonb,
              ${outcome.assessment ? JSON.stringify(outcome.assessment) : null}::text::jsonb)`;
          })
          .catch(async (error: unknown) => {
            await sql`SELECT kordos_risks.fail_job(${id}, ${inputRevision})`;
            return { error };
          });
      });
      if (failure) throw failure.error;
    },
    list(
      [actor, workspace]: Scope,
      project: string,
      cursor: string | null,
      history: boolean,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_risks.directory(${project}, ${cursor}, ${history}) AS value`;
        return row?.value;
      });
    },
    detail([actor, workspace]: Scope, project: string, id: string) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_risks.detail(${project}, ${id}) AS value`;
        return row?.value;
      });
    },
    act(
      [actor, workspace]: Scope,
      project: string,
      id: string,
      input: RiskAction,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const request = JSON.stringify(input);
        let outcome;
        if (input.action === "clarify" || input.action === "refresh") {
          const [row] =
            await sql`SELECT kordos_risks.lock_finding(${project}, ${id}, ${request}::text::jsonb) AS value`;
          const check = commandResult.parse(row?.value);
          if (check.result !== "ready") return check;
          const { source, priorTaskId } = context.parse(check);
          outcome = await evaluate(
            sql,
            workspace,
            source,
            input.action === "clarify"
              ? input.taskId
              : (priorTaskId ?? undefined),
          );
          if (!outcome?.assessment) return { result: "invalid_state" };
        }
        const [row] =
          await sql`SELECT kordos_risks.change_finding(${project}, ${id}, ${request}::text::jsonb,
          ${outcome ? JSON.stringify(outcome.snapshot) : null}::text::jsonb,
          ${outcome?.assessment ? JSON.stringify(outcome.assessment) : null}::text::jsonb) AS value`;
        return commandResult.parse(row?.value);
      });
    },
  };
}
