import {
  duplicateActionSchema,
  duplicateReviewSchema,
  idSchema,
  projectCommandResponseSchema,
  weeklyReportsSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const projectParams = z.object({ workspaceId: idSchema, projectId: idSchema });
const taskParams = projectParams.extend({ workId: idSchema });
const reportQuery = z.object({
  period: z.iso
    .date()
    .refine((value) => !value.startsWith("0000"))
    .optional(),
});

export function registerProjectHealth(
  api: FastifyInstance,
  db: ReturnType<typeof connectDatabase>["projectHealth"],
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  const base = "/workspaces/:workspaceId/projects/:projectId";
  api.get(base + "/weekly-health", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const { period } = parse(reportQuery, request.query);
    const data = await db.reports(
      [actor, workspaceId],
      projectId,
      period ?? null,
    );
    if (!data) throw unavailable();
    return weeklyReportsSchema.parse(data);
  });

  const duplicates = base + "/work/:workId/duplicates";
  api.get(duplicates, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, workId } = parse(
      taskParams,
      request.params,
    );
    const data = await db.duplicates([actor, workspaceId], projectId, workId);
    if (!data) throw unavailable();
    return duplicateReviewSchema.parse(data);
  });

  api.post(duplicates, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, workId } = parse(
      taskParams,
      request.params,
    );
    const input = parse(duplicateActionSchema, request.body);
    const outcome = await db.act(
      [actor, workspaceId],
      projectId,
      workId,
      input,
    );
    switch (outcome.result) {
      case "saved":
        return reply
          .code(input.action === "consolidate" ? 201 : 200)
          .send(projectCommandResponseSchema.parse(outcome));
      case "unavailable":
        throw unavailable();
      case "forbidden":
        throw new IdentityError(
          403,
          "forbidden",
          "A project contributor or lead can review duplicates.",
        );
      case "cycle":
        throw new IdentityError(
          409,
          "conflict",
          "Consolidating this pair would create a dependency cycle. Review the graph.",
        );
      case "invalid_state":
        throw new IdentityError(
          409,
          "invalid_state",
          "Only open tasks in an active project can be reviewed as duplicates.",
        );
      case "conflict":
      case "mutation_conflict":
        throw new IdentityError(
          409,
          "conflict",
          "A task or its dependencies changed. Review the latest comparison.",
        );
      default:
        throw new Error("Unexpected duplicate command outcome.");
    }
  });
}
