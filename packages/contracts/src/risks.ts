import { z } from "zod";
import { commentSubjectSchema } from "./collaboration.js";
import { scheduleCalendarSchema, scheduleInputSchema } from "./forecast.js";
import { idSchema } from "./identity.js";
import { personSchema, workItemSchema } from "./planning.js";

const version = workItemSchema.shape.version;
const date = scheduleInputSchema.shape.asOf;
const instant = z.iso.datetime({ offset: true });

export const riskSeveritySchema = z.enum([
  "at_risk",
  "watch",
  "clarify",
  "unchanged",
]);
const status = z.enum(["open", "acknowledged", "resolved", "superseded"]);
const work = z.object({
  id: idSchema,
  title: z.string(),
  owner: personSchema.nullable(),
});
const node = work.extend({
  baseline: date.nullable(),
  forecast: date.nullable(),
  commitment: date.nullable(),
  provisional: z.boolean(),
});
const milestone = node.extend({ path: z.array(work).min(2) });

export const riskAssessmentSchema = z.object({
  severity: riskSeveritySchema,
  excerpt: z.string().min(1).max(1000),
  handoff: date.nullable(),
  task: work.nullable(),
  taskClarified: z.boolean(),
  candidates: z.array(work),
  affected: z.array(node),
  milestones: z.array(milestone),
});

export const riskSummarySchema = z.object({
  id: idSchema,
  version,
  status,
  severity: riskSeveritySchema,
  title: z.string(),
  capturedAt: instant,
  author: personSchema,
  superseded: z.boolean(),
});
export const riskPageSchema = z.object({
  items: z.array(riskSummarySchema),
  nextCursor: idSchema.nullable(),
});
export const riskDetailSchema = riskSummarySchema.extend({
  assessment: riskAssessmentSchema,
  calendar: scheduleCalendarSchema,
  inputRevision: scheduleInputSchema.shape.inputRevision,
  asOf: date,
  source: z.object({ id: idSchema, version, subject: commentSubjectSchema }),
  previousId: idSchema.nullable(),
  nextId: idSchema.nullable(),
  proposalId: idSchema.nullable(),
  staleSchedule: z.boolean(),
  sourceChanged: z.boolean(),
  review: z
    .object({
      actor: personSchema,
      occurredAt: instant,
      reason: z.string().nullable(),
    })
    .nullable(),
  canClarify: z.boolean(),
  canReview: z.boolean(),
});

const precondition = z.object({
  mutationId: idSchema,
  expectedVersion: version,
});
export const riskActionSchema = z.discriminatedUnion("action", [
  precondition.extend({ action: z.literal("clarify"), taskId: idSchema }),
  precondition.extend({
    action: z.enum(["acknowledge", "resolve", "refresh"]),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine((value) => !value.includes("\0"))
      .optional(),
  }),
  precondition.extend({
    action: z.literal("replan"),
    milestoneId: idSchema,
    commitment: date,
  }),
]);
export const riskJobSchema = z.object({
  id: idSchema,
  actor: idSchema,
  workspace: idSchema,
});
export const riskSourceSchema = z.object({
  projectId: idSchema,
  commentId: idSchema,
  sourceVersion: version,
  capturedAt: instant,
  subject: commentSubjectSchema,
  body: z.string().min(1).max(4000),
});
export const riskQueue = "kordos-risks";

export type RiskSummary = z.infer<typeof riskSummarySchema>;
export type RiskAction = z.infer<typeof riskActionSchema>;
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;
export type RiskDetail = z.infer<typeof riskDetailSchema>;
export type RiskSource = z.infer<typeof riskSourceSchema>;
export type RiskJob = z.infer<typeof riskJobSchema>;
