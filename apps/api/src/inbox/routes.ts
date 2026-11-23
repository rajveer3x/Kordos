import {
  idSchema,
  inboxEntrySchema,
  inboxFilterSchema,
  inboxHomeSchema,
  inboxPageSchema,
  inboxPreferencesSchema,
  inboxReadSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const workspace = "/workspaces/:workspaceId";
const inbox = workspace + "/inbox";
const workspaceParams = z.object({ workspaceId: idSchema });
const entryParams = workspaceParams.extend({ id: idSchema });
const homeQuery = z.object({
  sort: z.enum(["age", "milestone"]).default("age"),
});
const preferenceResult = z.discriminatedUnion("result", [
  z.object({ result: z.literal("invalid") }),
  z.object({
    result: z.enum(["saved", "conflict"]),
    preferences: inboxPreferencesSchema,
  }),
]);

export function registerInbox(
  api: FastifyInstance,
  db: ReturnType<typeof connectDatabase>["inbox"],
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  api.get(inbox, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const value = await db.directory(
      [actor, workspaceId],
      parse(inboxFilterSchema, request.query),
    );
    if (!value) throw unavailable();
    return inboxPageSchema.parse(value);
  });

  for (const method of ["GET", "PATCH"] as const) {
    api.route({
      method,
      url: inbox + "/:id",
      async handler(request) {
        const actor = await requireActor(request);
        const { workspaceId, id } = parse(entryParams, request.params);
        const read =
          method === "PATCH"
            ? parse(inboxReadSchema, request.body).read
            : undefined;
        const value = await db.entry([actor, workspaceId], id, read);
        if (!value) throw unavailable();
        return inboxEntrySchema.parse(value);
      },
    });
  }

  api.get(workspace + "/notification-preferences", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const value = await db.preferences([actor, workspaceId]);
    if (!value) throw unavailable();
    return inboxPreferencesSchema.parse(value);
  });

  api.patch(workspace + "/notification-preferences", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const input = parse(inboxPreferencesSchema, request.body);
    const value = await db.preferences([actor, workspaceId], input);
    if (!value) throw unavailable();
    const result = preferenceResult.parse(value);
    if (result.result === "invalid") {
      throw new IdentityError(
        400,
        "invalid_input",
        "Check the timezone and notification settings.",
      );
    }
    if (result.result === "conflict") {
      throw new IdentityError(
        409,
        "conflict",
        "Preferences changed in another session.",
        result.preferences,
      );
    }
    return result.preferences;
  });

  api.get(workspace + "/home", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const { sort } = parse(homeQuery, request.query);
    const value = await db.home([actor, workspaceId], sort);
    if (!value) throw unavailable();
    return inboxHomeSchema.parse(value);
  });
}
