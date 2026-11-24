import { z } from "zod";
import { briefPlanSchema } from "./briefs.js";
import {
  githubCommentCommandSchema,
  githubRemoteReceiptSchema,
} from "./github.js";
import { idSchema } from "./identity.js";
import { citationSchema, resolvedCitationSchema } from "./knowledge.js";
import { meetingItemValuesSchema } from "./meetings.js";
import { personSchema, workFieldsSchema } from "./planning.js";
import { consolidationSchema } from "./project-health.js";

const version = z.number().int().positive().max(2147483647);
const instant = z.iso.datetime({ offset: true });
const date = z.iso.date().refine((value) => !value.startsWith("0000"));
const precondition = {
  mutationId: idSchema,
  expectedVersion: version,
  revision: version,
};
const draft = {
  targetVersion: version,
  command: z.object({ kind: z.literal("work.edit"), values: workFieldsSchema }),
  evidence: z.array(citationSchema).max(12),
  expiresAt: instant.optional(),
};
const reason = z
  .string()
  .trim()
  .min(1)
  .max(1500)
  .refine((value) => !value.includes("\0"));

export const createProposalSchema = z.object({
  mutationId: idSchema,
  workId: idSchema,
  ...draft,
});
export const reviseProposalSchema = z.object({ ...precondition, ...draft });
export const reviewVersionSchema = z.object(precondition);
export const reviewReasonSchema = reviewVersionSchema.extend({ reason });

export const proposalStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "applying",
  "applied",
  "stale",
  "rejected",
  "expired",
  "failed",
  "reconciliation_required",
]);
export const executionIssueSchema = z.enum([
  "superseded",
  "target_changed",
  "access_changed",
  "evidence_changed",
  "expired",
  "target_unavailable",
  "invalid_change",
  "worker_failed",
  "risk_stale",
  "ambiguous_effect",
  "destination_unavailable",
  "provider_refused",
]);
export const executionSchema = z.object({
  id: idSchema,
  status: proposalStatusSchema,
  reviewer: personSchema,
  approvedAt: instant,
  finishedAt: instant.nullable(),
  issue: executionIssueSchema.nullable(),
  effectEventId: idSchema.nullable(),
  auditId: idSchema,
  remote: githubRemoteReceiptSchema.nullable().optional(),
});
const summary = z.object({
  id: idSchema,
  projectId: idSchema,
  projectName: z.string(),
  title: z.string(),
  status: proposalStatusSchema,
  requester: personSchema,
  requestedAt: instant,
  revision: version,
});
const workTarget = { workId: idSchema, kind: z.enum(["task", "milestone"]) };
const meetingTarget = {
  meetingId: idSchema,
  meetingItemId: idSchema,
  kind: z.literal("meeting"),
};
const planTarget = { briefId: idSchema, kind: z.literal("plan") };
const githubTarget = {
  githubSourceId: idSchema.nullable(),
  kind: z.literal("github"),
};
export const proposalSummarySchema = z.discriminatedUnion("kind", [
  summary.extend(workTarget),
  summary.extend(planTarget),
  summary.extend(meetingTarget),
  summary.extend(githubTarget),
]);
const detail = summary.extend({
  version,
  revisionHead: version,
  targetVersion: version,
  currentTargetVersion: version,
  expiresAt: instant,
  author: personSchema,
  reviewer: personSchema.nullable(),
  reviewedAt: instant.nullable(),
  reason: z.string().nullable(),
  owners: z.array(personSchema),
  evidence: z.array(resolvedCitationSchema),
  evidenceRestricted: z.boolean(),
  riskContext: z.object({ id: idSchema, stale: z.boolean() }).optional(),
  receipt: executionSchema.nullable(),
  canEdit: z.boolean(),
  canSubmit: z.boolean(),
  canReview: z.boolean(),
});
export const proposalDetailSchema = z.discriminatedUnion("kind", [
  detail.extend({
    ...githubTarget,
    githubComment: githubCommentCommandSchema.nullable(),
  }),
  detail.extend({
    ...workTarget,
    consolidation: consolidationSchema.optional(),
    before: workFieldsSchema.nullable(),
    after: workFieldsSchema.nullable(),
  }),
  detail.extend({
    ...planTarget,
    plan: briefPlanSchema.nullable(),
    createdWork: z.record(idSchema, idSchema).nullable(),
  }),
  detail.extend({
    ...meetingTarget,
    meetingItem: meetingItemValuesSchema.nullable(),
    meetingWorkId: idSchema.nullable(),
    meetingDecisionId: idSchema.nullable(),
  }),
]);
export const reviewResponseSchema = z.object({
  id: idSchema,
  revision: version,
  receiptId: idSchema.optional(),
});
export const proposalPageSchema = z.object({
  items: z.array(proposalSummarySchema),
  pendingCount: z.number().int().nonnegative(),
  nextCursor: idSchema.nullable(),
});
export const approvalQueue = "kordos-approvals";
export const approvalJobSchema = z.object({ id: idSchema });
export type ApprovalJob = z.infer<typeof approvalJobSchema>;

const workSnapshotSchema = workFieldsSchema.safeExtend({
  version,
  archived: z.boolean(),
  completedAt: instant.nullable(),
});
export const activityTypeSchema = z.enum([
  "work",
  "dependency",
  "discussion",
  "document",
  "decision",
  "meeting",
  "risk",
  "review",
  "brief",
  "project",
  "connector",
  "other",
]);
export const activitySourceSchema = z.enum(["workspace", "github"]);
const activityEntitySchema = z.object({
  kind: z.enum([
    "work",
    "comment",
    "document",
    "decision",
    "meeting",
    "risk",
    "review",
    "brief",
    "github",
  ]),
  id: idSchema,
  revision: version.nullable(),
});
export const auditFilterSchema = z
  .object({
    eventId: idSchema.optional(),
    projectId: idSchema.optional(),
    actorId: idSchema.optional(),
    type: activityTypeSchema.optional(),
    source: activitySourceSchema.optional(),
    targetId: idSchema.optional(),
    githubCommentUrl: githubRemoteReceiptSchema.shape.url
      .max(310)
      .refine((url) =>
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/[1-9]\d*#issuecomment-[1-9]\d*$/i.test(
          url,
        ),
      )
      .optional(),
    from: date.optional(),
    to: date.optional(),
    cursor: idSchema.optional(),
  })
  .refine(({ from, to }) => !from || !to || from <= to);
export const auditPageSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      projectId: idSchema.nullable(),
      projectName: z.string().nullable(),
      targetId: idSchema,
      workId: idSchema.nullable(),
      action: z.string(),
      type: activityTypeSchema,
      source: activitySourceSchema,
      entity: activityEntitySchema.nullable(),
      actor: personSchema,
      actorType: z.enum(["user", "service"]),
      occurredAt: instant,
      proposalId: idSchema.nullable(),
      revision: version.nullable(),
      receiptId: idSchema.nullable(),
      before: workSnapshotSchema.nullable(),
      after: workSnapshotSchema.nullable(),
    }),
  ),
  nextCursor: idSchema.nullable(),
});

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalDetail = z.infer<typeof proposalDetailSchema>;
export type AuditFilter = z.infer<typeof auditFilterSchema>;
export type AuditEntry = z.infer<typeof auditPageSchema>["items"][number];
export type WorkFields = z.infer<typeof workFieldsSchema>;
