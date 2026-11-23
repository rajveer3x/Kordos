import { createHash, createHmac } from "node:crypto";
import {
  connectorCommandSchema,
  connectorDirectorySchema,
  connectorSavedSchema,
  connectorSchema,
  connectorShareSchema,
  connectorSourcesSchema,
  connectorSourceSchema,
  createConnectorSchema,
  idSchema,
  revokeConnectorShareSchema,
} from "@kordos/contracts";
import { sealConnectorCredential, type connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

export type ConnectorStore = ReturnType<typeof connectDatabase>["connectors"];
const workspace = "/workspaces/:workspaceId";
const connectors = workspace + "/connectors";
const sources = workspace + "/projects/:projectId/connector-sources";
const workspaceParams = z.object({ workspaceId: idSchema });
const connectorParams = workspaceParams.extend({ id: idSchema });
const projectParams = workspaceParams.extend({ projectId: idSchema });
const sourceParams = projectParams.extend({ id: idSchema });
const sourceQuery = z.object({
  revision: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .pipe(z.number().max(2147483647))
    .optional(),
});

export function connectorWriteResult(
  value: { result: string; id?: string; current?: unknown } | null | undefined,
) {
  if (!value) throw unavailable();
  switch (value.result) {
    case "saved":
      return connectorSavedSchema.parse(value);
    case "conflict":
      throw new IdentityError(
        409,
        "conflict",
        "This connection changed. Review its latest settings.",
        connectorSchema.parse(value.current),
      );
    case "mutation_conflict":
      throw new IdentityError(
        409,
        "conflict",
        "This request was already used for a different change.",
      );
    case "scope_exists":
      throw new IdentityError(
        409,
        "conflict",
        "This scope already has a project mapping.",
      );
    case "source_changed":
      throw new IdentityError(
        409,
        "conflict",
        "Open the latest source revision before sharing.",
      );
    case "invalid_excerpt":
      throw new IdentityError(
        400,
        "invalid_input",
        "Choose an exact excerpt from the source.",
      );
    default:
      throw new IdentityError(
        409,
        "invalid_state",
        "This action is unavailable for the connection.",
      );
  }
}

export function registerConnectors(
  api: FastifyInstance,
  db: ConnectorStore,
  requireActor: (request: FastifyRequest) => Promise<string>,
  key?: string,
) {
  function credentials(
    workspaceId: string,
    id: string,
    input: object,
    token?: string,
  ) {
    if (token !== undefined && !key) throw unavailable();
    const fingerprint =
      token !== undefined && key
        ? createHmac("sha256", Buffer.from(key, "base64url"))
            .update(JSON.stringify(input))
            .digest("hex")
        : createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return {
      fingerprint,
      sealed:
        token !== undefined && key
          ? sealConnectorCredential(key, workspaceId, id, token)
          : null,
    };
  }

  api.get(connectors, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const value = await db.list([actor, workspaceId]);
    if (!value) throw unavailable();
    return connectorDirectorySchema.parse({ ...value, enabled: !!key });
  });

  api.post(connectors, async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const input = parse(createConnectorSchema, request.body);
    const { token, ...settings } = input;
    const { fingerprint, sealed } = credentials(
      workspaceId,
      input.mutationId,
      input,
      token,
    );
    const result = connectorWriteResult(
      await db.manage(
        [actor, workspaceId],
        input.mutationId,
        { ...settings, action: "create" },
        sealed,
        fingerprint,
      ),
    );
    return reply.code(201).send(result);
  });

  api.patch(connectors + "/:id", async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, id } = parse(connectorParams, request.params);
    const input = parse(connectorCommandSchema, request.body);
    const { token, ...settings } = {
      token: undefined as string | undefined,
      ...input,
    };
    const { fingerprint, sealed } = credentials(workspaceId, id, input, token);
    const result = connectorWriteResult(
      await db.manage([actor, workspaceId], id, settings, sealed, fingerprint),
    );
    return reply.code(input.action === "sync" ? 202 : 200).send(result);
  });

  api.get(sources, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId } = parse(projectParams, request.params);
    const { cursor } = parse(
      z.object({ cursor: idSchema.optional() }),
      request.query,
    );
    const page = await db.sources(
      [actor, workspaceId],
      projectId,
      cursor ?? null,
    );
    if (!page) throw unavailable();
    return connectorSourcesSchema.parse(page);
  });

  api.get(sources + "/:id", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(sourceParams, request.params);
    const { revision } = parse(sourceQuery, request.query);
    const source = await db.source(
      [actor, workspaceId],
      projectId,
      id,
      revision ?? null,
    );
    if (!source) throw unavailable();
    return connectorSourceSchema.parse(source);
  });

  api.post(sources + "/:id/shares", async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(sourceParams, request.params);
    const input = parse(connectorShareSchema, request.body);
    const result = connectorWriteResult(
      await db.share([actor, workspaceId], projectId, id, input),
    );
    return reply.code(201).send(result);
  });

  api.post(sources + "/:id/revoke", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, projectId, id } = parse(sourceParams, request.params);
    const { mutationId } = parse(revokeConnectorShareSchema, request.body);
    return connectorWriteResult(
      await db.revoke([actor, workspaceId], projectId, id, mutationId),
    );
  });
}
