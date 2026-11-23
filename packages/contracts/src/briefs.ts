import { z } from "zod";
import { idSchema, timeZoneSchema } from "./identity.js";
import { personSchema } from "./planning.js";
import { passageAnchorSchema, resolvedCitationSchema } from "./knowledge.js";

const clean = z.string().refine((value) => !value.includes("\0"));
const title = z.string().trim().min(1).max(160).pipe(clean);
const taskTitle = z.string().trim().min(1).max(180).pipe(clean);
const days = z.number().int().min(1).max(3650);
const date = z.iso.date().refine((value) => !value.startsWith("0000"));
const instant = z.iso.datetime({ offset: true });
const version = z.number().int().min(1).max(2147483647);
const description = z.string().max(2000).pipe(clean).nullable();

export const pasteBriefSchema = z.object({
  mutationId: idSchema,
  title,
  content: z
    .string()
    .max(16000)
    .pipe(clean)
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.replace(/\r\n?/g, "\n")),
});
export const createBriefSchema = z.union([
  pasteBriefSchema,
  z.object({
    mutationId: idSchema,
    documentId: idSchema,
    sourceRevision: version,
  }),
]);
export const workBriefOriginSchema = z.object({
  origin: z
    .object({
      briefId: idSchema,
      proposalId: idSchema,
      revision: version,
      title,
      evidence: z.array(resolvedCitationSchema),
    })
    .nullable(),
});
export const retryBriefSchema = z.object({
  mutationId: idSchema,
  expectedVersion: version,
});

const certainty = z.enum(["explicit", "inferred", "missing", "edited"]);
const task = z.object({
  id: idSchema,
  title: taskTitle,
  description,
  ownerId: idSchema.nullable(),
  estimateDays: days.nullable(),
  deadline: date.nullable(),
  certainty: z.object({
    owner: certainty,
    estimate: certainty,
    deadline: certainty,
  }),
  passages: z.array(passageAnchorSchema).max(3),
});
const dependency = z.object({ predecessorId: idSchema, successorId: idSchema });
export const briefPlanSchema = z.object({
  tasks: z.array(task).min(1).max(24),
  edges: z.array(dependency).max(60),
});
export type BriefPlan = z.infer<typeof briefPlanSchema>;

const modelId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const modelDeadline = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), value: date }),
  z.object({
    kind: z.literal("relative"),
    value: z.enum([
      "today",
      "tomorrow",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "next monday",
      "next tuesday",
      "next wednesday",
      "next thursday",
      "next friday",
      "next saturday",
      "next sunday",
    ]),
  }),
]);
export const modelBriefSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: modelId,
        title: taskTitle,
        description,
        owner: z.string().min(1).max(180).pipe(clean).nullable(),
        estimateDays: days.nullable(),
        estimateInferred: z.boolean(),
        deadline: modelDeadline.nullable(),
        quote: z.string().min(1).max(1000).pipe(clean),
      }),
    )
    .min(1)
    .max(24),
  edges: z
    .array(z.object({ predecessorId: modelId, successorId: modelId }))
    .max(60),
});
export type ModelBrief = z.infer<typeof modelBriefSchema>;

const briefStatus = z.enum(["queued", "running", "ready", "failed"]);
const failure = z.enum([
  "timeout",
  "provider_unavailable",
  "invalid_output",
  "access_changed",
  "interrupted",
]);
export type BriefFailure = z.infer<typeof failure>;
const summary = z.object({
  id: idSchema,
  title,
  status: briefStatus,
  proposalId: idSchema.nullable(),
});
export const briefListSchema = z.object({
  items: z.array(summary),
  nextCursor: idSchema.nullable(),
});
export const briefJobSchema = summary.extend({
  content: z.string(),
  author: personSchema,
  documentId: idSchema,
  sourceRevision: version,
  capturedAt: instant,
  timeZone: timeZoneSchema,
  attempt: z.number().int().min(1).max(3),
  version,
  failure: failure.nullable(),
  candidates: briefPlanSchema.nullable(),
  canEdit: z.boolean(),
});

export const briefWorkerJobSchema = z.object({
  id: idSchema,
  attempt: z.number().int().min(1).max(3),
});
export type BriefWorkerJob = z.infer<typeof briefWorkerJobSchema>;
export const briefQueue = "kordos-briefs";

export const saveBriefPlanSchema = z.object({
  mutationId: idSchema,
  briefId: idSchema,
  plan: briefPlanSchema,
});
export const reviseBriefPlanSchema = z.object({
  mutationId: idSchema,
  revision: version,
  expectedVersion: version,
  plan: briefPlanSchema,
});
