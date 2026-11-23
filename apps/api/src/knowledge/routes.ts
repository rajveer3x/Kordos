import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  attachmentMaxBytes,
  attachmentNameSchema,
  citationSchema,
  decisionCommandSchema,
  decisionDirectorySchema,
  decisionSchema,
  documentCommandSchema,
  documentDetailSchema,
  documentDirectorySchema,
  idSchema,
  projectCommandResponseSchema,
  resolvedCitationSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

type Store = ReturnType<typeof connectDatabase>["knowledge"];
type Write = Awaited<ReturnType<Store["saveDocument"]>>;
const project = "/workspaces/:workspaceId/projects/:projectId";
const scope = z.object({ workspaceId: idSchema, projectId: idSchema });
const target = scope.extend({ id: idSchema });
const number = z.coerce.number().int().min(0).max(2147483647);

function written(result: Write) {
  if (result.result === "saved")
    return projectCommandResponseSchema.parse({ id: result.id });
  if (result.result === "unavailable") throw unavailable();
  if (result.result === "invalid_reference") {
    throw new IdentityError(
      400,
      "invalid_input",
      "Check that the accountable person, evidence, and any earlier decision are available for this change.",
    );
  }
  if (result.result === "invalid_state") {
    throw new IdentityError(
      409,
      "invalid_state",
      "This item can no longer be changed. Refresh and try again.",
    );
  }
  throw new IdentityError(
    409,
    "conflict",
    "This item has changed. Review the latest version before retrying.",
    result.result === "conflict" && result.current
      ? documentDetailSchema.parse(result.current)
      : undefined,
  );
}

export function registerKnowledge(
  api: FastifyInstance,
  db: Store,
  requireActor: (request: FastifyRequest) => Promise<string>,
  storage: S3Client,
  bucket: string,
) {
  api.get(project + "/documents", async (request) => {
    const actor = await requireActor(request);
    const where = parse(scope, request.params);
    const { archived } = parse(
      z.object({ archived: z.enum(["true", "false"]).optional() }),
      request.query,
    );
    const result = await db.documents(actor, where, archived === "true");
    if (!result) throw unavailable();
    return documentDirectorySchema.parse(result);
  });
  api.get(project + "/documents/:id", async (request) => {
    const actor = await requireActor(request);
    const where = parse(target, request.params);
    const { revision } = parse(
      z.object({ revision: number.min(1).optional() }),
      request.query,
    );
    const result = await db.document(actor, where, where.id, revision ?? null);
    if (!result) throw unavailable();
    return documentDetailSchema.parse(result);
  });
  api.post(project + "/documents", async (request) => {
    const actor = await requireActor(request);
    const where = parse(scope, request.params);
    const command = parse(documentCommandSchema, request.body);
    if (command.action !== "create") throw unavailable();
    return written(await db.saveDocument(actor, where, null, command));
  });
  api.patch(project + "/documents/:id", async (request) => {
    const actor = await requireActor(request);
    const where = parse(target, request.params);
    const command = parse(documentCommandSchema, request.body);
    if (command.action === "create") throw unavailable();
    return written(await db.saveDocument(actor, where, where.id, command));
  });

  api.get(project + "/decisions", async (request) => {
    const actor = await requireActor(request);
    const where = parse(scope, request.params);
    const result = await db.decisions(actor, where, null);
    if (!result) throw unavailable();
    return decisionDirectorySchema.parse(result);
  });
  api.get(project + "/decisions/:id", async (request) => {
    const actor = await requireActor(request);
    const where = parse(target, request.params);
    const result = await db.decisions(actor, where, where.id);
    if (!result) throw unavailable();
    return decisionSchema.parse(result);
  });
  api.post(project + "/decisions", async (request) => {
    const actor = await requireActor(request);
    const where = parse(scope, request.params);
    const command = parse(decisionCommandSchema, request.body);
    if (command.action !== "draft") throw unavailable();
    return written(await db.saveDecision(actor, where, null, command));
  });
  api.patch(project + "/decisions/:id", async (request) => {
    const actor = await requireActor(request);
    const where = parse(target, request.params);
    const command = parse(decisionCommandSchema, request.body);
    if (command.action === "draft") throw unavailable();
    return written(await db.saveDecision(actor, where, where.id, command));
  });

  api.get(project + "/evidence/:kind/:id", async (request) => {
    const actor = await requireActor(request);
    const where = parse(
      target.extend({ kind: z.enum(["document", "comment"]) }),
      request.params,
    );
    const { kind, projectId, id } = where;
    const anchor =
      kind === "document"
        ? parse(
            z.object({ revision: number, start: number, end: number }),
            request.query,
          )
        : undefined;
    const source = parse(citationSchema, { kind, projectId, id, anchor });
    const result = await db.resolveCitation(actor, where.workspaceId, source);
    if (!result) throw unavailable();
    return resolvedCitationSchema.parse(result);
  });

  api.register(async (files) => {
    files.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: attachmentMaxBytes },
      (_request, bytes, done) => done(null, bytes),
    );
    files.post(project + "/documents/:id/attachments", async (request) => {
      const actor = await requireActor(request);
      const where = parse(target, request.params);
      const fields = parse(
        z.object({ name: attachmentNameSchema, mutationId: idSchema }),
        request.query,
      );
      const body = request.body;
      if (
        !Buffer.isBuffer(body) ||
        body.length === 0 ||
        body.length > attachmentMaxBytes
      ) {
        throw new IdentityError(
          400,
          "invalid_input",
          "Choose a file between 1 byte and 10 MB.",
        );
      }
      const input = {
        ...fields,
        size: body.length,
        digest: createHash("sha256").update(body).digest("hex"),
      };
      const prepared = await db.upload(actor, where, where.id, input, false);
      if (prepared.result !== "pending") return written(prepared);
      await storage.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: prepared.key,
          Body: body,
          ContentType: "application/octet-stream",
        }),
        { abortSignal: AbortSignal.timeout(20_000) },
      );
      const finished = await db.upload(actor, where, where.id, input, true);
      if (finished.result === "pending")
        throw new Error("Attachment was not published.");
      return written(finished);
    });
    files.get(
      project + "/documents/:id/attachments/:file",
      async (request, reply) => {
        const actor = await requireActor(request);
        const where = parse(target.extend({ file: idSchema }), request.params);
        const object = await db.attachment(actor, where, where.id, where.file);
        if (!object) throw unavailable();
        const response = await storage.send(
          new GetObjectCommand({ Bucket: bucket, Key: object.key }),
          { abortSignal: AbortSignal.timeout(20_000) },
        );
        if (!response.Body) throw unavailable();
        const filename = encodeURIComponent(object.name).replace(
          /['()*]/g,
          (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
        );
        return reply
          .header(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" + filename,
          )
          .header("Content-Length", object.size)
          .header("X-Content-Type-Options", "nosniff")
          .type("application/octet-stream")
          .send(response.Body);
      },
    );
  });
}
