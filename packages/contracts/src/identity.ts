import { z } from "zod";

export const idSchema = z.uuidv4();
export const workspaceRoleSchema = z.enum(["viewer", "contributor", "admin"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, "Enter an IANA timezone, such as Asia/Kolkata.");

export const workspaceSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  timeZone: timeZoneSchema,
  role: workspaceRoleSchema,
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const sessionIdentitySchema = z.object({
  id: idSchema,
  name: z.string(),
  email: emailSchema.nullable(),
  emailVerified: z.boolean(),
});
export const sessionResponseSchema = z.object({
  identity: sessionIdentitySchema.nullable(),
  signInAvailable: z.boolean(),
});
export type SessionIdentity = z.infer<typeof sessionIdentitySchema>;

export const createWorkspaceSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  timeZone: timeZoneSchema,
});
export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;
export const workspacesResponseSchema = z.array(workspaceSummarySchema);

export const workspaceProjectSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.enum(["restricted", "workspace"]),
  archived: z.boolean(),
});
export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>;
export const workspaceDetailSchema = z.object({
  accessEpoch: z.string().regex(/^\d+$/),
  workspace: workspaceSummarySchema,
  projects: z.array(workspaceProjectSchema),
});

export const memberSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: emailSchema.nullable(),
  role: workspaceRoleSchema,
  version: z.number().int().positive(),
});
export const membersResponseSchema = z.array(memberSchema);
export type WorkspaceMember = z.infer<typeof memberSchema>;

export const updateMemberSchema = z.object({
  expectedVersion: memberSchema.shape.version,
  role: workspaceRoleSchema.nullable(),
});
export type UpdateMember = z.infer<typeof updateMemberSchema>;

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: workspaceRoleSchema,
});
export type CreateInvitation = z.infer<typeof createInvitationSchema>;

export const invitationTokenSchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
export const invitationSchema = z.object({
  token: invitationTokenSchema,
  expiresAt: z.iso.datetime(),
});
export const acceptInvitationSchema = z.object({
  token: invitationTokenSchema,
});

export const identityErrorSchema = z.object({
  code: z.enum([
    "invalid_input",
    "signed_out",
    "unavailable",
    "forbidden",
    "last_admin",
    "conflict",
    "last_lead",
    "invalid_state",
  ]),
  message: z.string(),
  current: z.unknown().optional(),
});
