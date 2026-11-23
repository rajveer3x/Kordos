import {
  idSchema,
  riskActionSchema,
  riskDetailSchema,
  riskPageSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const projectParams = z.object({ workspaceId: idSchema, projectId: idSchema });
const riskParams = projectParams.extend({ id: idSchema });
const querySchema = z.object({
  cursor: idSchema.optional(),
  history: z.literal("true").optional(),
});
const responseSchema = z.object({
  id: idSchema,
  proposalId: idSchema.optional(),
});

export function registerRisks(
  api: FastifyInstance,
  db: ReturnType<typeof connectDatabase>["risks"],
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  const base = "/workspaces/:workspaceId/projects/:projectId/risks";
  api.get(base, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const { cursor, history } = parse(querySchema, request.query);
    const page = await db.list(
      [actor, workspaceId],
      projectId,
      cursor ?? null,
      history === "true",
    );
    if (!page) throw unavailable();
    return riskPageSchema.parse(page);
  });
  api.get(base + "/:id", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(riskParams, request.params);
    const detail = await db.detail([actor, workspaceId], projectId, id);
    if (!detail) throw unavailable();
    return riskDetailSchema.parse(detail);
  });
  api.post(base + "/:id", async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(riskParams, request.params);
    const input = parse(riskActionSchema, request.body);
    const scope: [string, string] = [actor, workspaceId];
    const outcome = await db.act(scope, projectId, id, input);
    switch (outcome.result) {
      case "saved": {
        const saved = responseSchema.parse(outcome);
        return saved.proposalId
          ? reply
              .code(201)
              .header(
                "Location",
                `/api/workspaces/${workspaceId}/proposals/${saved.proposalId}`,
              )
              .send({ ...saved, id: saved.proposalId })
          : saved;
      }
      case "unavailable":
        throw unavailable();
      case "forbidden":
        throw new IdentityError(
          403,
          "forbidden",
          "The author can clarify the task and a project lead can review the risk.",
        );
      case "stale":
      case "evidence_changed":
      case "target_changed":
      case "mutation_conflict":
      case "conflict": {
        const current = riskDetailSchema.safeParse(
          await db.detail(scope, projectId, id),
        ).data;
        throw new IdentityError(
          409,
          "conflict",
          "The report or schedule changed. Open the latest risk and refresh the forecast.",
          current,
        );
      }
      case "invalid_state":
        throw new IdentityError(
          409,
          "invalid_state",
          "This action is unavailable for the current risk.",
        );
      default:
        throw new Error("Unexpected risk command outcome.");
    }
  });
}
