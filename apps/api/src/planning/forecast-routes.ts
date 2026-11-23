import {
  createScenarioSchema,
  cyclePathSchema,
  dependencyChangeSchema,
  graphSchema,
  idSchema,
  projectCommandResponseSchema,
  scenarioSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const projectPath = "/workspaces/:workspaceId/projects/:projectId";
const projectParams = z.object({ workspaceId: idSchema, projectId: idSchema });
const scenarioParams = projectParams.extend({ scenarioId: idSchema });

export function registerForecast(
  api: FastifyInstance,
  db: ReturnType<typeof connectDatabase>["forecast"],
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  api.get(`${projectPath}/graph`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const graph = await db.graph([actor, workspaceId], projectId);
    if (!graph) throw unavailable();
    return graphSchema.parse(graph);
  });

  api.post(`${projectPath}/dependencies`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const command = await db.changeDependency(
      [actor, workspaceId],
      projectId,
      parse(dependencyChangeSchema, request.body),
    );
    switch (command.result) {
      case "saved":
        return projectCommandResponseSchema.parse({ id: command.id });
      case "cycle":
        throw new IdentityError(
          409,
          "conflict",
          "This dependency would create a cycle.",
          cyclePathSchema.parse({ path: command.path }),
        );
      case "conflict":
        throw new IdentityError(
          409,
          "conflict",
          "The graph changed. Refresh it and review your dependency.",
          { graphVersion: command.graphVersion },
        );
      case "invalid_state":
        throw new IdentityError(
          409,
          "invalid_state",
          "This dependency is unavailable in the current graph.",
        );
      case "mutation_conflict":
        throw new IdentityError(
          409,
          "conflict",
          "This request was already used.",
        );
      case "unavailable":
        throw unavailable();
    }
  });

  api.post(`${projectPath}/scenarios`, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const command = await db.createScenario(
      [actor, workspaceId],
      projectId,
      parse(createScenarioSchema, request.body),
    );
    switch (command.result) {
      case "saved":
        return reply.code(201).send(scenarioSchema.parse(command.scenario));
      case "conflict":
        throw new IdentityError(
          409,
          "conflict",
          "The forecast inputs changed. Refresh the baseline and preview again.",
          command.current,
        );
      case "invalid_state":
        throw new IdentityError(
          409,
          "invalid_state",
          "Choose unfinished tasks in an active project.",
        );
      case "past_handoff":
        throw new IdentityError(
          400,
          "invalid_input",
          "Choose a handoff date on or after the forecast date.",
        );
      case "mutation_conflict":
        throw new IdentityError(
          409,
          "conflict",
          "This request was already used.",
        );
      case "unavailable":
        throw unavailable();
    }
  });

  api.get(`${projectPath}/scenarios/:scenarioId`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, scenarioId } = parse(
      scenarioParams,
      request.params,
    );
    const scenario = await db.scenario(
      [actor, workspaceId],
      projectId,
      scenarioId,
    );
    if (!scenario) throw unavailable();
    return scenarioSchema.parse(scenario);
  });

  api.delete(`${projectPath}/scenarios/:scenarioId`, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, scenarioId } = parse(
      scenarioParams,
      request.params,
    );
    if (!(await db.discard([actor, workspaceId], projectId, scenarioId)))
      throw unavailable();
    return reply.code(204).send();
  });
}
