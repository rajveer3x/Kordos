import {
  audienceSchema,
  changeProjectMemberSchema,
  createProjectSchema,
  createWorkSchema,
  idSchema,
  projectCommandResponseSchema,
  projectPeopleSchema,
  projectSchema,
  updateProjectSchema,
  updateWorkSchema,
  workFilterSchema,
  workHistorySchema,
  workItemSchema,
  workPageSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

type Planning = ReturnType<typeof connectDatabase>["planning"];
const workspace = "/workspaces/:workspaceId";
const project = `${workspace}/projects/:projectId`;
const work = `${project}/work/:workId`;
const workspaceParams = z.object({ workspaceId: idSchema });
const projectParams = workspaceParams.extend({ projectId: idSchema });
const workParams = projectParams.extend({ workId: idSchema });
const memberParams = projectParams.extend({ userId: idSchema });
const cursorParams = workFilterSchema.pick({ cursor: true });
const historyVersion = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .transform(Number)
  .pipe(z.number().max(2147483647));

function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>) {
  if (cursor === undefined) return;
  const decoded = Buffer.from(cursor, "base64url");
  if (decoded.toString("base64url") !== cursor) {
    throw new IdentityError(400, "invalid_input", "This page link is invalid.");
  }
  return parse(schema, decoded.toString("utf8"));
}

function encodePage<T>(
  page: { items: T[]; nextCursor: string | null } | undefined,
) {
  if (!page) throw unavailable();
  return {
    items: page.items,
    nextCursor: page.nextCursor
      ? Buffer.from(page.nextCursor).toString("base64url")
      : null,
  };
}

function saved({
  command,
  current,
}: Awaited<ReturnType<Planning["saveProject" | "saveWork" | "saveMember"]>>) {
  switch (command.result) {
    case "saved":
      return projectCommandResponseSchema.parse({ id: command.id });
    case "conflict":
      throw new IdentityError(
        409,
        "conflict",
        "Someone saved a newer version. Review it and keep editing your draft.",
        current,
      );
    case "mutation_conflict":
      throw new IdentityError(
        409,
        "conflict",
        "This request was already used. Review the latest changes and try again.",
      );
    case "invalid_state":
      throw new IdentityError(
        409,
        "invalid_state",
        "This change is unavailable in the current state.",
      );
    case "invalid_owner":
      throw new IdentityError(
        400,
        "invalid_input",
        "Choose an active project contributor or lead as owner.",
      );
    case "invalid_role":
      throw new IdentityError(
        400,
        "invalid_input",
        "Workspace viewers can only hold the project viewer role.",
      );
    case "commitment_requires_lead":
      throw new IdentityError(
        403,
        "forbidden",
        "A project lead must change the milestone commitment.",
      );
    case "last_lead":
      throw new IdentityError(
        409,
        "last_lead",
        "Assign another project lead first.",
      );
    case "unavailable":
      throw unavailable();
  }
}

export function registerPlanning(
  api: FastifyInstance,
  db: Planning,
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  api.get(`${workspace}/project-audience`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const count = await db.audience([actor, workspaceId]);
    if (count == null) throw unavailable();
    return audienceSchema.parse({ count });
  });

  api.post(`${workspace}/projects`, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const result = saved(
      await db.saveProject(
        [actor, workspaceId],
        null,
        parse(createProjectSchema, request.body),
      ),
    );
    return reply.code(201).send(result);
  });

  api.get(project, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const details = await db.project([actor, workspaceId], projectId);
    if (!details) throw unavailable();
    return projectSchema.parse(details);
  });

  api.patch(project, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    return saved(
      await db.saveProject(
        [actor, workspaceId],
        projectId,
        parse(updateProjectSchema, request.body),
      ),
    );
  });

  api.get(`${project}/people`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const people = await db.people([actor, workspaceId], projectId);
    if (!people) throw unavailable();
    return projectPeopleSchema.parse(people);
  });

  api.patch(`${project}/members/:userId`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, userId } = parse(
      memberParams,
      request.params,
    );
    return saved(
      await db.saveMember(
        [actor, workspaceId],
        projectId,
        userId,
        parse(changeProjectMemberSchema, request.body),
      ),
    );
  });

  api.get(`${workspace}/assigned-work`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const { cursor } = parse(cursorParams, request.query);
    return workPageSchema.parse(
      encodePage(
        await db.workPage([actor, workspaceId], {
          after: decodeCursor(cursor, idSchema),
        }),
      ),
    );
  });

  api.get(`${project}/work`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const filter = parse(workFilterSchema, request.query);
    return workPageSchema.parse(
      encodePage(
        await db.workPage([actor, workspaceId], {
          project: projectId,
          filter,
          after: decodeCursor(filter.cursor, idSchema),
        }),
      ),
    );
  });

  api.post(`${project}/work`, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const result = saved(
      await db.saveWork(
        [actor, workspaceId],
        projectId,
        null,
        parse(createWorkSchema, request.body),
      ),
    );
    return reply.code(201).send(result);
  });

  api.get(work, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, workId } = parse(
      workParams,
      request.params,
    );
    const item = await db.work([actor, workspaceId], projectId, workId);
    if (!item) throw unavailable();
    return workItemSchema.parse(item);
  });

  api.patch(work, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, workId } = parse(
      workParams,
      request.params,
    );
    return saved(
      await db.saveWork(
        [actor, workspaceId],
        projectId,
        workId,
        parse(updateWorkSchema, request.body),
      ),
    );
  });

  api.get(`${work}/history`, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, workId } = parse(
      workParams,
      request.params,
    );
    const { cursor } = parse(cursorParams, request.query);
    return workHistorySchema.parse(
      encodePage(
        await db.history(
          [actor, workspaceId],
          projectId,
          workId,
          decodeCursor(cursor, historyVersion),
        ),
      ),
    );
  });
}
