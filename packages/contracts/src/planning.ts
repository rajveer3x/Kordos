import { z } from "zod";
import { idSchema, timeZoneSchema } from "./identity.js";

export const projectVisibilitySchema = z.enum(["restricted", "workspace"]);
export const projectRoleSchema = z.enum(["viewer", "contributor", "lead"]);
export const workStatusSchema = z.enum([
  "backlog",
  "ready",
  "in_progress",
  "done",
]);
export const workKindSchema = z.enum(["task", "milestone"]);
const versionSchema = z.number().int().positive().max(2147483647);
const dateSchema = z.iso.date().refine((date) => !date.startsWith("0000"));
const descriptionSchema = z.string().trim().max(12000).nullable();

export const projectFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: descriptionSchema,
  visibility: projectVisibilitySchema.default("restricted"),
  timeZone: timeZoneSchema,
  workdays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length),
  nonworkingDates: z
    .array(dateSchema)
    .max(366)
    .refine((dates) => new Set(dates).size === dates.length),
});

const mutation = z.object({ mutationId: idSchema });
const revision = mutation.extend({ expectedVersion: versionSchema });
export const createProjectSchema = projectFieldsSchema.extend(mutation.shape);
export const updateProjectSchema = z.discriminatedUnion("action", [
  projectFieldsSchema.extend({ ...revision.shape, action: z.literal("edit") }),
  revision.extend({ action: z.enum(["archive", "reopen"]) }),
]);
export const changeProjectMemberSchema = mutation.extend({
  expectedVersion: versionSchema.nullable(),
  role: projectRoleSchema.nullable(),
});

export const personSchema = z.object({ id: idSchema, name: z.string() });
export const projectMemberSchema = personSchema.extend({
  role: projectRoleSchema,
  version: versionSchema,
});
export const projectPeopleSchema = z.object({
  owners: z.array(personSchema),
  members: z.array(projectMemberSchema),
  candidates: z.array(personSchema),
});

export const projectSchema = projectFieldsSchema.extend({
  id: idSchema,
  version: versionSchema,
  archived: z.boolean(),
  role: projectRoleSchema,
  lead: personSchema.nullable(),
  commitment: dateSchema.nullable(),
  activeCount: z.number().int().nonnegative(),
});
export const audienceSchema = z.object({
  count: z.number().int().nonnegative(),
});
export const projectCommandResponseSchema = z.object({ id: idSchema });

const workFields = z.object({
  title: z.string().trim().min(1).max(180),
  description: descriptionSchema,
  kind: workKindSchema,
  status: workStatusSchema,
  ownerId: idSchema.nullable(),
  estimateDays: z.number().int().min(1).max(3650).nullable(),
  deadline: dateSchema.nullable(),
  commitment: dateSchema.nullable(),
  blockerReason: z.string().trim().min(1).max(2000).nullable(),
  blockerOwnerId: idSchema.nullable(),
  blockerResolution: z.string().trim().min(1).max(2000).nullable(),
});

function validWork(item: z.infer<typeof workFields>) {
  return (
    (item.kind === "milestone" || item.commitment === null) &&
    (item.blockerReason !== null ||
      (item.blockerOwnerId === null && item.blockerResolution === null))
  );
}
export const workFieldsSchema = workFields.refine(validWork);
export const createWorkSchema = workFields
  .extend(mutation.shape)
  .refine(validWork);
export const updateWorkSchema = z.discriminatedUnion("action", [
  workFields
    .extend({ ...revision.shape, action: z.literal("edit") })
    .refine(validWork),
  revision.extend({ action: z.enum(["archive", "restore", "reopen"]) }),
]);

export const workItemSchema = workFields.extend({
  id: idSchema,
  projectId: idSchema,
  projectName: z.string(),
  owner: personSchema.nullable(),
  blockerOwner: personSchema.nullable(),
  version: versionSchema,
  archived: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
});
export const workPageSchema = z.object({
  items: z.array(workItemSchema),
  nextCursor: z.string().nullable(),
});
const workRevisionSchema = workFields.extend({
  version: versionSchema,
  archived: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
});
const workEventSchema = z.object({
  id: idSchema,
  action: z.enum([
    "work.created",
    "work.edited",
    "work.completed",
    "work.reopened",
    "work.archived",
    "work.restored",
  ]),
  actor: personSchema,
  occurredAt: z.iso.datetime(),
  before: workRevisionSchema.nullable(),
  after: workRevisionSchema,
});
export const workHistorySchema = z.object({
  items: z.array(workEventSchema),
  nextCursor: z.string().nullable(),
});
export const workFilterSchema = z.object({
  q: z.string().trim().max(180).optional(),
  status: workStatusSchema.optional(),
  kind: workKindSchema.optional(),
  archived: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(150).optional(),
});
export type ProjectDetails = z.infer<typeof projectSchema>;
export type ProjectPeople = z.infer<typeof projectPeopleSchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkHistory = z.infer<typeof workHistorySchema>;
export type WorkFilter = z.infer<typeof workFilterSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type ChangeProjectMember = z.infer<typeof changeProjectMemberSchema>;
export type CreateWork = z.infer<typeof createWorkSchema>;
export type UpdateWork = z.infer<typeof updateWorkSchema>;
