import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  createMeetingSchema,
  idSchema,
  meetingAudioDescriptorSchema,
  meetingAudioMaxBytes,
  meetingAudioTypes,
  meetingChangesSchema,
  meetingDetailSchema,
  meetingItemCommandSchema,
  meetingPageSchema,
  meetingUploadSchema,
  meetingWorkOriginSchema,
  projectCommandResponseSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const project = "/workspaces/:workspaceId/projects/:projectId";
const meetings = project + "/meetings";
const meeting = meetings + "/:id";
const scope = z.object({ workspaceId: idSchema, projectId: idSchema });
const itemScope = scope.extend({ id: idSchema });
const revisionQuery = z.object({
  revision: z.coerce.number().int().min(1).max(2147483647).optional(),
});
const resultSchema = projectCommandResponseSchema.extend({
  proposalId: idSchema.optional(),
});

function hasAudioHeader(
  bytes: Buffer,
  extension: keyof typeof meetingAudioTypes,
) {
  if (extension === "wav")
    return (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE"
    );
  if (extension === "m4a") return bytes.toString("ascii", 4, 8) === "ftyp";
  return (
    bytes.toString("ascii", 0, 3) === "ID3" ||
    (bytes[0] === 255 && (bytes[1]! & 224) === 224)
  );
}

function requestedRange(raw: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end
  )
    return `bytes=${start}-${end}`;
}

function saved(value: { result: string }, current?: unknown) {
  if (value.result === "saved") return resultSchema.parse(value);
  if (value.result === "unavailable") throw unavailable();
  if (value.result === "forbidden")
    throw new IdentityError(
      403,
      "forbidden",
      "A project lead must reject this item.",
    );
  if (value.result === "invalid_input")
    throw new IdentityError(
      400,
      "invalid_input",
      "Check the item, its accountable owner, and the selected date.",
    );
  if (
    ["conflict", "mutation_conflict", "invalid_state"].includes(value.result)
  ) {
    throw new IdentityError(
      409,
      "conflict",
      "The meeting or item changed. Review the current version and try again.",
      current,
    );
  }
  throw new Error("Unexpected meeting command outcome.");
}

export function registerMeetings(
  api: FastifyInstance,
  db: ReturnType<typeof connectDatabase>["meetings"],
  requireActor: (request: FastifyRequest) => Promise<string>,
  storage: S3Client,
  bucket: string,
) {
  api.get(meetings, async (request) => {
    const actor = await requireActor(request);
    const target = parse(scope, request.params);
    const { cursor } = parse(
      z.object({ cursor: idSchema.optional() }),
      request.query,
    );
    const result = await db.directory(actor, target, cursor ?? null);
    if (!result) throw unavailable();
    return meetingPageSchema.parse(result);
  });
  api.get(meeting, async (request) => {
    const actor = await requireActor(request);
    const target = parse(itemScope, request.params);
    const { revision } = parse(revisionQuery, request.query);
    const result = await db.detail(actor, target, target.id, revision ?? null);
    if (!result) throw unavailable();
    return meetingDetailSchema.parse(result);
  });
  api.post(meetings, async (request, reply) => {
    const actor = await requireActor(request);
    const target = parse(scope, request.params);
    const input = parse(createMeetingSchema, request.body);
    return reply
      .code(201)
      .send(
        saved(
          await db.write(actor, target, null, { ...input, action: "create" }),
        ),
      );
  });
  api.patch(meeting, async (request, reply) => {
    const actor = await requireActor(request);
    const target = parse(itemScope, request.params);
    const input = parse(meetingChangesSchema, request.body);
    const result = await db.write(actor, target, target.id, input);
    const current =
      result.result === "conflict"
        ? meetingDetailSchema.safeParse(
            await db.detail(actor, target, target.id, null),
          ).data
        : undefined;
    if (["retry", "paste", "reprocess"].includes(input.action))
      reply
        .code(202)
        .header(
          "Location",
          `/api/workspaces/${target.workspaceId}/projects/${target.projectId}/meetings/${target.id}`,
        );
    return saved(result, current);
  });
  api.post(meeting + "/items/:itemId", async (request, reply) => {
    const actor = await requireActor(request);
    const target = parse(
      itemScope.extend({ itemId: idSchema }),
      request.params,
    );
    const input = parse(meetingItemCommandSchema, request.body);
    const result = await db.item(
      actor,
      target,
      target.id,
      target.itemId,
      input,
    );
    const current =
      result.result === "conflict"
        ? meetingDetailSchema
            .safeParse(await db.detail(actor, target, target.id, null))
            .data?.items.find(({ id }) => id === target.itemId)
        : undefined;
    const response = saved(result, current);
    if (response.proposalId) reply.code(201);
    return response;
  });
  api.get(project + "/work/:id/meeting-origin", async (request) => {
    const actor = await requireActor(request);
    const target = parse(itemScope, request.params);
    const result = await db.origin(actor, target, target.id);
    if (!result) throw unavailable();
    return meetingWorkOriginSchema.parse(result);
  });

  api.register(async (files) => {
    files.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: meetingAudioMaxBytes },
      (_request, bytes, done) => done(null, bytes),
    );
    files.post(
      meeting + "/audio",
      {
        bodyLimit: meetingAudioMaxBytes,
        onRequest: async (request) => {
          await requireActor(request);
        },
      },
      async (request, reply) => {
        const actor = await requireActor(request);
        const target = parse(itemScope, request.params);
        const input = parse(
          meetingUploadSchema.extend({
            expectedVersion: z.coerce.number().int().min(1).max(2147483647),
          }),
          request.query,
        );
        const body = request.body;
        if (
          !Buffer.isBuffer(body) ||
          body.length > meetingAudioMaxBytes ||
          body.length < 12 ||
          !hasAudioHeader(body, input.extension)
        ) {
          throw new IdentityError(
            400,
            "invalid_input",
            "Choose an MP3, WAV or M4A recording up to 20 MB.",
          );
        }
        const upload = {
          ...input,
          size: body.length,
          digest: createHash("sha256").update(body).digest("hex"),
        };
        const reserved = await db.upload(
          actor,
          target,
          target.id,
          upload,
          false,
        );
        if (reserved.result !== "pending")
          return reply.code(202).send(saved(reserved));
        if (!reserved.key)
          throw new Error("Meeting audio reservation has no storage key.");
        try {
          await storage.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: reserved.key,
              Body: body,
              ContentType: meetingAudioTypes[input.extension],
            }),
            { abortSignal: AbortSignal.timeout(20000) },
          );
        } catch (error) {
          await db
            .abortUpload(actor, target, target.id, input.mutationId)
            .catch(() => {});
          throw error;
        }
        const response = saved(
          await db.upload(actor, target, target.id, upload, true),
        );
        return reply
          .code(202)
          .header(
            "Location",
            `/api/workspaces/${target.workspaceId}/projects/${target.projectId}/meetings/${target.id}`,
          )
          .send(response);
      },
    );
  });

  api.get(meeting + "/audio/:recordingId", async (request, reply) => {
    const actor = await requireActor(request);
    const target = parse(
      itemScope.extend({ recordingId: idSchema }),
      request.params,
    );
    const raw = await db.audio(actor, target, target.id, target.recordingId);
    if (!raw) throw unavailable();
    const media = meetingAudioDescriptorSchema.parse(raw);
    const range = request.headers.range
      ? requestedRange(request.headers.range, media.size)
      : undefined;
    reply
      .header("Cache-Control", "private, no-store")
      .header("Accept-Ranges", "bytes")
      .header("X-Content-Type-Options", "nosniff");
    if (request.headers.range && !range)
      return reply
        .code(416)
        .header("Content-Range", `bytes */${media.size}`)
        .send();
    const response = await storage.send(
      new GetObjectCommand({ Bucket: bucket, Key: media.key, Range: range }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
    if (!response.Body) throw unavailable();
    const stillAvailable = await db.audio(
      actor,
      target,
      target.id,
      target.recordingId,
    );
    if (!stillAvailable) {
      if (
        "destroy" in response.Body &&
        typeof response.Body.destroy === "function"
      )
        response.Body.destroy();
      throw unavailable();
    }
    if (response.ContentRange)
      reply.code(206).header("Content-Range", response.ContentRange);
    if (response.ContentLength !== undefined)
      reply.header("Content-Length", response.ContentLength);
    return reply.type(meetingAudioTypes[media.extension]).send(response.Body);
  });
}
