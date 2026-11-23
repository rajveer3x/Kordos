import type {
  AuditFilter,
  createProposalSchema,
  githubCommentDraftSchema,
  githubCommentRevisionSchema,
  reviseProposalSchema,
  reviewReasonSchema,
  reviewVersionSchema,
  saveBriefPlanSchema,
  reviseBriefPlanSchema,
} from "@kordos/contracts";
import { dependencyPath } from "@kordos/domain";
import type { Sql } from "postgres";
import type { z } from "zod";
import { databaseScope } from "./identity.js";

type ReviewAction =
  | {
      action: "create";
      input: z.infer<
        | typeof createProposalSchema
        | typeof saveBriefPlanSchema
        | typeof githubCommentDraftSchema
      >;
    }
  | {
      action: "revise";
      input: z.infer<
        | typeof reviseProposalSchema
        | typeof reviseBriefPlanSchema
        | typeof githubCommentRevisionSchema
      >;
    }
  | { action: "submit" | "approve"; input: z.infer<typeof reviewVersionSchema> }
  | {
      action: "request_edit" | "reject";
      input: z.infer<typeof reviewReasonSchema>;
    };

export function reviewsStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    directory(
      [actor, workspace]: [string, string],
      cursor: string | null,
      pending: boolean,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_reviews.directory(${cursor}, ${pending}) AS value`;
        return row?.value;
      });
    },
    detail(
      [actor, workspace]: [string, string],
      id: string,
      revision: number | null,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_reviews.detail(${id}, ${revision}) AS value`;
        return row?.value;
      });
    },
    mutate(
      [actor, workspace]: [string, string],
      target: { projectId?: string; proposalId?: string },
      { action, input }: ReviewAction,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ value: { result: string } }[]>`
          SELECT kordos_reviews.mutate(${target.projectId ?? null}, ${target.proposalId ?? null},
            ${action}, ${JSON.stringify(input)}::jsonb) AS value
        `;
        const outcome = row!.value;
        if (outcome.result !== "cycle" || !("plan" in input)) return outcome;
        const { edges, tasks } = input.plan;
        for (const { predecessorId, successorId } of edges) {
          const path = dependencyPath(edges, successorId, predecessorId);
          if (path) {
            const titles = new Map(tasks.map((task) => [task.id, task.title]));
            return {
              ...outcome,
              cycle: [predecessorId, ...path].map((id) => titles.get(id) ?? id),
            };
          }
        }
        return outcome;
      });
    },
    audit([actor, workspace]: [string, string], filter: AuditFilter) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_reviews.audit(${JSON.stringify(filter)}::jsonb) AS value`;
        return row?.value;
      });
    },
    pending: () =>
      client<{ id: string }[]>`SELECT id FROM kordos_reviews.pending()`,
    async run(id: string, step: "claim" | "apply" | "fail") {
      const [row] = await client<
        { value: boolean }[]
      >`SELECT kordos_reviews.run(${id}, ${step}) AS value`;
      return row!.value;
    },
  };
}
