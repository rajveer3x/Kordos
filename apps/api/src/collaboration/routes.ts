import {
  collaborationCursorSchema,
  collaborationScopeSchema,
  commentCommandSchema,
  commentFeedSchema,
  commentSnapshotSchema,
  idSchema,
  projectCommandResponseSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

export type CollaborationStore = ReturnType<
  typeof connectDatabase
>["collaboration"];

const path =
  "/workspaces/:workspaceId/projects/:projectId/discussions/:kind/:subjectId";
const paramsSchema = z.object({
  workspaceId: idSchema,
  projectId: idSchema,
  kind: z.string(),
  subjectId: idSchema,
});

function scope(request: FastifyRequest) {
  const { workspaceId, projectId, kind, subjectId } = parse(
    paramsSchema,
    request.params,
  );
  return parse(collaborationScopeSchema, {
    workspaceId,
    projectId,
    subject: { kind, id: subjectId },
  });
}

export function encodeCursor(position: string) {
  return Buffer.from(position).toString("base64url");
}

export function decodeCursor(cursor: string) {
  const position = Buffer.from(cursor, "base64url").toString("ascii");
  if (
    !/^(0|[1-9]\d{0,18})$/.test(position) ||
    encodeCursor(position) !== cursor ||
    BigInt(position) > 9223372036854775807n
  ) {
    throw new IdentityError(
      400,
      "invalid_input",
      "This discussion cursor is invalid.",
    );
  }
  return position;
}

export function publicChange<T extends { cursor: string }>(event: T) {
  return { ...event, cursor: encodeCursor(event.cursor) };
}

export function registerCollaboration(
  api: FastifyInstance,
  store: CollaborationStore,
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  api.get(path, async (request) => {
    const actor = await requireActor(request);
    const { before } = parse(
      z.object({ before: idSchema.optional() }),
      request.query,
    );
    const result = await store.snapshot(actor, scope(request), before ?? null);
    if (!result) throw unavailable();
    return commentSnapshotSchema.parse({
      ...result,
      cursor: encodeCursor(result.cursor),
    });
  });

  api.get(`${path}/events`, async (request) => {
    const actor = await requireActor(request);
    const { after } = parse(
      z.object({ after: collaborationCursorSchema }),
      request.query,
    );
    const result = await store.feed(actor, scope(request), decodeCursor(after));
    if (!result) throw unavailable();
    return commentFeedSchema.parse({
      events: result.events.map(publicChange),
      more: result.more,
    });
  });

  api.post(path, async (request) => {
    const actor = await requireActor(request);
    const target = scope(request);
    const command = parse(commentCommandSchema, request.body);
    const result = await store.save(actor, target, command);
    switch (result.result) {
      case "saved":
        return projectCommandResponseSchema.parse({ id: result.id });
      case "unavailable":
        throw unavailable();
      case "invalid_mention":
        throw new IdentityError(
          400,
          "invalid_input",
          "Choose people who can access this discussion.",
        );
      case "invalid_anchor":
        throw new IdentityError(
          400,
          "invalid_input",
          "Select a passage from a saved document revision.",
        );
      case "invalid_state":
        throw new IdentityError(
          409,
          "invalid_state",
          "This discussion has changed. Refresh it and try again.",
        );
      case "conflict": {
        const current =
          command.action === "post"
            ? undefined
            : await store.current(actor, target, command.commentId);
        if (!current) throw unavailable();
        throw new IdentityError(
          409,
          "conflict",
          "This comment has changed. Review the latest version before retrying.",
          current,
        );
      }
      case "mutation_conflict":
        throw new IdentityError(
          409,
          "conflict",
          "This comment has changed. Review the latest version before retrying.",
        );
    }
  });
}
