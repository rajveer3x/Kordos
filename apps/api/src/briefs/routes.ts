import {
  briefJobSchema,
  briefListSchema,
  createBriefSchema,
  idSchema,
  projectCommandResponseSchema,
  retryBriefSchema,
  workBriefOriginSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const directory = "/workspaces/:workspaceId/projects/:projectId/briefs";
const target = directory + "/:id";
const projectParams = z.object({ workspaceId: idSchema, projectId: idSchema });
const workParams = projectParams.extend({ workId: idSchema });
const briefParams = projectParams.extend({ id: idSchema });
const listQuery = z.object({ cursor: idSchema.optional() });

function saved(value: { result: string }, current?: unknown) {
  switch (value.result) {
    case "saved":
      return projectCommandResponseSchema.parse(value);
    case "unavailable":
      throw unavailable();
    case "invalid_input":
      throw new IdentityError(
        400,
        "invalid_input",
        "Use a document revision with 1–16,000 characters of brief text.",
      );
    case "conflict":
    case "mutation_conflict":
      throw new IdentityError(
        409,
        "conflict",
        "The brief changed. Check its current status and try again.",
        current,
      );
    case "invalid_state":
      throw new IdentityError(
        409,
        "invalid_state",
        "A retry is unavailable for this brief.",
      );
    default:
      throw new Error("Unexpected brief command outcome.");
  }
}

export function registerBriefs(
  api: FastifyInstance,
  db: ReturnType<typeof connectDatabase>["briefs"],
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  api.get(
    "/workspaces/:workspaceId/projects/:projectId/work/:workId/brief-origin",
    async (request) => {
      const actor = await requireActor(request);
      const { workspaceId, projectId, workId } = parse(
        workParams,
        request.params,
      );
      const origin = await db.origin([actor, workspaceId], projectId, workId);
      if (!origin) throw unavailable();
      return workBriefOriginSchema.parse(origin);
    },
  );
  api.get(directory, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const { cursor } = parse(listQuery, request.query);
    const page = await db.list([actor, workspaceId], projectId, cursor ?? null);
    if (!page) throw unavailable();
    return briefListSchema.parse(page);
  });
  api.get(target, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(briefParams, request.params);
    const result = await db.detail([actor, workspaceId], projectId, id);
    if (!result) throw unavailable();
    return briefJobSchema.parse(result);
  });
  api.post(directory, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const result = saved(
      await db.create(
        [actor, workspaceId],
        projectId,
        parse(createBriefSchema, request.body),
      ),
    );
    return reply
      .code(202)
      .header(
        "Location",
        `/api/workspaces/${workspaceId}/projects/${projectId}/briefs/${result.id}`,
      )
      .send(result);
  });
  api.post(target + "/retry", async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(briefParams, request.params);
    const scope: [string, string] = [actor, workspaceId];
    const result = await db.retry(
      scope,
      projectId,
      id,
      parse(retryBriefSchema, request.body),
    );
    const current =
      result.result === "conflict"
        ? briefJobSchema.safeParse(await db.detail(scope, projectId, id)).data
        : undefined;
    return reply
      .code(202)
      .header(
        "Location",
        `/api/workspaces/${workspaceId}/projects/${projectId}/briefs/${id}`,
      )
      .send(saved(result, current));
  });
}
