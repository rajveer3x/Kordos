import { z } from "zod";
import { idSchema, timeZoneSchema } from "./identity.js";
import { personSchema, workItemSchema } from "./planning.js";

const version = workItemSchema.shape.version;
const instant = z.iso.datetime({ offset: true });
const date = workItemSchema.shape.deadline.unwrap();
const clean = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"));
const title = clean(160);
const speaker = clean(100).nullable();
const milliseconds = z
  .number()
  .int()
  .min(0)
  .max(12 * 60 * 60 * 1000);
export const meetingRetentionSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
]);
export const meetingAudioTypes = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
} as const;
export const meetingAudioExtensionSchema = z.enum(["mp3", "wav", "m4a"]);
export const meetingAudioMaxBytes = 20 * 1024 * 1024;

export const createMeetingSchema = z.object({
  mutationId: idSchema,
  title,
  agenda: clean(4000).nullable(),
  startsAt: instant,
  retentionDays: meetingRetentionSchema,
});
const precondition = z.object({
  mutationId: idSchema,
  expectedVersion: version,
});
export const meetingChangesSchema = z.discriminatedUnion("action", [
  precondition.extend({ action: z.literal("paste"), content: clean(80000) }),
  precondition.extend({
    action: z.literal("correct"),
    segmentId: idSchema,
    text: clean(2000),
    speaker,
  }),
  precondition.extend({
    action: z.enum(["retry", "reprocess", "remove-audio"]),
  }),
  createMeetingSchema.extend({
    action: z.literal("edit"),
    expectedVersion: version,
  }),
]);

export const meetingSegmentSchema = z
  .object({
    id: idSchema,
    startMs: milliseconds.nullable(),
    endMs: milliseconds.nullable(),
    text: clean(2000),
    speaker,
  })
  .refine(({ startMs, endMs }) =>
    startMs === null ? endMs === null : endMs !== null && endMs > startMs,
  );

export const meetingAnchorSchema = z
  .object({
    revision: version,
    segmentId: idSchema,
    start: z.number().int().min(0).max(1999),
    end: z.number().int().min(1).max(2000),
  })
  .refine(({ start, end }) => end > start);
export const meetingTranscriptSchema = z
  .array(meetingSegmentSchema)
  .min(1)
  .max(320)
  .refine(
    (segments) =>
      new Set(segments.map(({ id }) => id)).size === segments.length &&
      segments.reduce((size, segment) => size + segment.text.length, 0) <=
        80000,
  );

export const meetingItemValuesSchema = z.object({
  kind: z.enum(["action", "decision", "question"]),
  title,
  detail: clean(2000).nullable(),
  ownerId: idSchema.nullable(),
  date: date.nullable(),
});
export const meetingItemCommandSchema = z.discriminatedUnion("action", [
  precondition.extend({
    action: z.literal("submit"),
    values: meetingItemValuesSchema,
  }),
  precondition.extend({ action: z.literal("reject") }),
]);
export const meetingExtractedItemSchema = meetingItemValuesSchema.extend({
  key: z.string().regex(/^[a-f0-9-]{36}:(action|decision|question):\d+$/),
  anchor: meetingAnchorSchema,
  ownerExplicit: z.boolean(),
  dateExplicit: z.boolean(),
});
export const meetingItemsSchema = z
  .array(meetingExtractedItemSchema)
  .max(160)
  .refine(
    (items) => new Set(items.map(({ key }) => key)).size === items.length,
  );
const state = z.enum(["empty", "queued", "processing", "ready", "failed"]);
export const meetingFailureSchema = z.enum([
  "timeout",
  "provider_unavailable",
  "invalid_transcript",
  "media_unavailable",
  "interrupted",
  "access_changed",
]);
export const meetingItemSchema = z.object({
  id: idSchema,
  version,
  values: meetingItemValuesSchema,
  anchor: meetingAnchorSchema,
  ownerExplicit: z.boolean(),
  dateExplicit: z.boolean(),
  status: z.enum(["suggested", "submitted", "stale", "accepted", "rejected"]),
  proposalId: idSchema.nullable(),
  workId: idSchema.nullable(),
  decisionId: idSchema.nullable(),
  completedAt: instant.nullable(),
  sourceChanged: z.boolean(),
});
const summary = z.object({
  id: idSchema,
  title,
  startsAt: instant,
  status: state,
  organizer: personSchema,
  calendarStatus: z.enum(["scheduled", "canceled"]).nullable(),
});
export const meetingPageSchema = z.object({
  items: z.array(summary),
  nextCursor: idSchema.nullable(),
});
export const meetingDetailSchema = summary.extend({
  version,
  agenda: z.string().nullable(),
  timeZone: timeZoneSchema,
  retentionDays: meetingRetentionSchema,
  audio: z.enum(["none", "pending", "available", "unavailable"]),
  expiresAt: instant.nullable(),
  attempt: z.number().int().min(0).max(3),
  failure: meetingFailureSchema.nullable(),
  revision: z.number().int().nonnegative(),
  transcript: z
    .object({
      revision: version,
      createdAt: instant,
      author: personSchema,
      recordingId: idSchema.nullable(),
      segments: meetingTranscriptSchema,
    })
    .nullable(),
  history: z.array(z.object({ revision: version, createdAt: instant })),
  items: z.array(meetingItemSchema),
  canManage: z.boolean(),
  canSubmit: z.boolean(),
  canReject: z.boolean(),
});
export const meetingWorkOriginSchema = z.object({
  origin: z
    .object({
      meetingId: idSchema,
      title,
      anchor: meetingAnchorSchema,
      proposalId: idSchema,
    })
    .nullable(),
});

export const meetingJobSchema = z.object({ id: idSchema, generation: version });
export const meetingAudioDescriptorSchema = z.object({
  key: z.string(),
  size: z.number().int().positive().max(meetingAudioMaxBytes),
  extension: meetingAudioExtensionSchema,
});
export const meetingClaimSchema = z.object({
  lease: idSchema,
  startsAt: instant,
  timeZone: timeZoneSchema,
  owners: z.array(personSchema),
  mode: z.enum(["transcribe", "paste", "extract"]),
  audio: meetingAudioDescriptorSchema.nullable(),
  text: z.string().nullable(),
  transcript: meetingTranscriptSchema.nullable(),
  revision: version,
});
export const meetingQueue = "kordos-meetings";

export type MeetingAnchor = z.infer<typeof meetingAnchorSchema>;
export type MeetingSegment = z.infer<typeof meetingSegmentSchema>;
export type MeetingExtractedItem = z.infer<typeof meetingExtractedItemSchema>;
export type MeetingFailure = z.infer<typeof meetingFailureSchema>;
export type MeetingDetail = z.infer<typeof meetingDetailSchema>;
export type MeetingJob = z.infer<typeof meetingJobSchema>;

export const meetingUploadSchema = precondition.extend({
  extension: meetingAudioExtensionSchema,
  authorized: z.literal("true"),
});
