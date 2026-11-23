import { z } from "zod";
import { idSchema } from "./identity.js";
import { personSchema } from "./planning.js";

const version = z.number().int().positive().max(2147483647);
const instant = z.iso.datetime({ offset: true });
const title = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((text) => !text.includes("\0"));
const content = z
  .string()
  .max(80000)
  .refine((text) => !text.includes("\0"))
  .transform((text) => text.replace(/\r\n?/g, "\n"));
const mutation = { mutationId: idSchema };

export const passageAnchorSchema = z
  .object({
    revision: version,
    start: z.number().int().min(0).max(80000),
    end: z.number().int().min(1).max(80000),
  })
  .refine(({ start, end }) => end > start && end - start <= 2000);

export const citationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    projectId: idSchema,
    id: idSchema,
    anchor: passageAnchorSchema,
  }),
  z.object({ kind: z.literal("comment"), projectId: idSchema, id: idSchema }),
]);
export type Citation = z.infer<typeof citationSchema>;
export type PassageAnchor = z.infer<typeof passageAnchorSchema>;

export const resolvedCitationSchema = z.object({
  source: citationSchema,
  title: z.string(),
  excerpt: z.string(),
  author: personSchema,
  capturedAt: instant,
  newer: z.boolean(),
  subject: z
    .object({
      kind: z.enum(["project", "task", "document", "meeting"]),
      id: idSchema,
    })
    .optional(),
});
export type ResolvedCitation = z.infer<typeof resolvedCitationSchema>;

export const documentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), ...mutation, title, content }),
  z.object({
    action: z.literal("save"),
    ...mutation,
    expectedVersion: version,
    title,
    content,
  }),
  z.object({
    action: z.literal("restore"),
    ...mutation,
    expectedVersion: version,
    revision: version,
  }),
  z.object({
    action: z.literal("archive"),
    ...mutation,
    expectedVersion: version,
  }),
]);
export type DocumentCommand = z.infer<typeof documentCommandSchema>;

export const documentSummarySchema = z.object({
  id: idSchema,
  title: z.string(),
  revision: version,
  version,
  archivedAt: instant.nullable(),
});

export const documentRevisionSchema = z.object({
  revision: version,
  title: z.string(),
  content: z.string(),
  author: personSchema,
  createdAt: instant,
  baseRevision: version.nullable(),
  restoredFrom: version.nullable(),
});
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;

export const attachmentMaxBytes = 10 * 1024 * 1024;
export const attachmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      !/[/\\\\]/u.test(name) &&
      Array.from(name).every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
  );
export const attachmentSchema = z.object({
  id: idSchema,
  name: z.string(),
  size: z.number().int().positive(),
});

export const documentDetailSchema = documentSummarySchema.extend({
  entry: documentRevisionSchema,
  history: z.array(documentRevisionSchema.omit({ content: true })),
  attachments: z.array(attachmentSchema),
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export const documentDirectorySchema = z.array(documentSummarySchema);

const note = z
  .string()
  .trim()
  .min(1)
  .max(6000)
  .refine((text) => !text.includes("\0"));
const decisionDraft = {
  question: title,
  conclusion: note,
  accountableId: idSchema,
  effectiveDate: z.iso.date(),
  evidence: z.array(citationSchema).min(1).max(12),
  supersedesId: idSchema.nullable(),
};
export const decisionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), ...mutation, ...decisionDraft }),
  z.object({
    action: z.literal("edit"),
    ...mutation,
    ...decisionDraft,
    expectedVersion: version,
  }),
  z.object({
    action: z.literal("confirm"),
    ...mutation,
    expectedVersion: version,
  }),
]);
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;

export const decisionSchema = z.object({
  id: idSchema,
  question: z.string(),
  conclusion: z.string(),
  accountable: personSchema,
  effectiveDate: z.iso.date(),
  evidence: z.array(resolvedCitationSchema),
  supersedesId: idSchema.nullable(),
  supersededById: idSchema.nullable(),
  author: personSchema,
  confirmedBy: personSchema.nullable(),
  confirmedAt: instant.nullable(),
  supersededOn: z.iso.date().nullable(),
  version,
});
export type Decision = z.infer<typeof decisionSchema>;

export const decisionDirectorySchema = z.object({
  items: z.array(decisionSchema.omit({ evidence: true, conclusion: true })),
  people: z.array(personSchema),
});
