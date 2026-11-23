import { z } from "zod";
import { idSchema } from "./identity.js";
import { personSchema } from "./planning.js";

export const commentSubjectSchema = z.object({
  kind: z.enum(["project", "task", "document", "meeting"]),
  id: idSchema,
});
export type CommentSubject = z.infer<typeof commentSubjectSchema>;

export const collaborationScopeSchema = z.object({
  workspaceId: idSchema,
  projectId: idSchema,
  subject: commentSubjectSchema,
});
export type CollaborationScope = z.infer<typeof collaborationScopeSchema>;

const content = {
  body: z.string().trim().min(1).max(4000),
  mentionIds: z
    .array(idSchema)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length),
};
const mutation = { mutationId: idSchema };
const target = {
  ...mutation,
  commentId: idSchema,
  expectedVersion: z.number().int().positive().max(2147483647),
};
export const commentCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("post"),
    ...mutation,
    ...content,
    parentId: idSchema.nullable(),
  }),
  z.object({ action: z.literal("edit"), ...target, ...content }),
  z.object({ action: z.enum(["resolve", "reopen"]), ...target }),
]);
export type CommentCommand = z.infer<typeof commentCommandSchema>;

export const commentSchema = z.object({
  id: idSchema,
  mutationId: idSchema,
  parentId: idSchema.nullable(),
  author: personSchema,
  body: z.string(),
  mentions: z.array(personSchema),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  editedAt: z.iso.datetime({ offset: true }).nullable(),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  resolvedBy: personSchema.nullable(),
});
export type Comment = z.infer<typeof commentSchema>;

export const collaborationCursorSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^[\w-]+$/);
export const commentSnapshotSchema = z.object({
  cursor: collaborationCursorSchema,
  items: z.array(commentSchema),
  older: idSchema.nullable(),
  canPost: z.boolean(),
  canModerate: z.boolean(),
  people: z.array(personSchema),
});

export type CommentSnapshot = z.infer<typeof commentSnapshotSchema>;

export const commentChangeSchema = z.object({
  id: idSchema,
  cursor: collaborationCursorSchema,
  kind: z.enum([
    "comment.posted",
    "comment.edited",
    "comment.resolved",
    "comment.reopened",
  ]),
  actorId: idSchema,
});
export type CommentChange = z.infer<typeof commentChangeSchema>;
export const commentFeedSchema = z.object({
  events: z.array(commentChangeSchema),
  more: z.boolean(),
});

export const presenceSchema = z.array(personSchema);
