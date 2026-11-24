import { z } from "zod";
import { idSchema, timeZoneSchema } from "./identity.js";
import { personSchema } from "./planning.js";

export const inboxReasonSchema = z.enum([
  "assignment",
  "mention",
  "review",
  "risk",
  "due",
  "overdue",
  "escalation",
]);
export type InboxReason = z.infer<typeof inboxReasonSchema>;

export const inboxModeSchema = z.enum(["in_app", "email", "digest"]);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const inboxPreferenceFieldsSchema = z.object({
  timeZone: timeZoneSchema,
  quietHours: z
    .object({ start: localTime, end: localTime })
    .refine(
      ({ start, end }) => start !== end,
      "Choose different start and end times.",
    )
    .nullable(),
  reminderDays: z.number().int().min(0).max(30),
  escalationDays: z.number().int().min(1).max(30),
  channels: z.record(inboxReasonSchema, inboxModeSchema),
});
export const inboxPreferencesSchema = inboxPreferenceFieldsSchema.extend({
  version: z.number().int().nonnegative(),
});
export type InboxPreferences = z.infer<typeof inboxPreferencesSchema>;

export const inboxFilterSchema = z.object({
  cursor: idSchema.optional(),
  digest: z.iso.date().optional(),
  reason: inboxReasonSchema.optional(),
  state: z.enum(["unread", "read", "resolved"]).optional(),
});
export type InboxFilter = z.infer<typeof inboxFilterSchema>;

const inboxTargetSchema = z.object({
  subjectId: idSchema,
  projectId: idSchema,
  projectName: z.string(),
  title: z.string(),
  deadline: z.iso.date().nullable(),
});
export const inboxEntrySchema = inboxTargetSchema.extend({
  id: idSchema,
  reason: inboxReasonSchema,
  revision: z.number().int().positive(),
  receivedAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  resolved: z.boolean(),
});
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const inboxPageSchema = z.object({
  items: z.array(inboxEntrySchema),
  nextCursor: idSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export const inboxReadSchema = z.object({ read: z.boolean() });

export const inboxHomeSchema = z.object({
  reviews: z.array(
    inboxTargetSchema.extend({
      requestedAt: z.iso.datetime({ offset: true }),
      milestone: z.string().nullable(),
      revision: z.number().int().positive(),
    }),
  ),
  pendingCount: z.number().int().nonnegative(),
  due: z.array(inboxTargetSchema),
  risks: z.array(
    inboxTargetSchema.extend({ severity: z.enum(["at_risk", "watch"]) }),
  ),
  mentions: z.array(
    inboxTargetSchema.extend({ receivedAt: z.iso.datetime({ offset: true }) }),
  ),
  decisions: z.array(
    z.object({
      id: idSchema,
      projectId: idSchema,
      projectName: z.string(),
      question: z.string(),
      effectiveDate: z.iso.date(),
      confirmedAt: z.iso.datetime({ offset: true }).nullable(),
      accountable: personSchema,
    }),
  ),
});
