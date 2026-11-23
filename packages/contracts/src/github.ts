import { z } from "zod";
import { idSchema } from "./identity.js";

export const githubNumberSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const githubIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((id) => Number.isSafeInteger(Number(id)));
export const githubRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i)
  .refine((name) => ![".", ".."].includes(name.split("/")[1]!))
  .transform((name) => name.toLowerCase());

export const githubBindingsSchema = z
  .string()
  .transform((raw, ctx): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected a JSON object" });
      return z.NEVER;
    }
  })
  .pipe(z.record(githubIdSchema, idSchema));

export const githubDestinationSchema = z.object({
  repository: githubRepositorySchema,
  repositoryId: githubIdSchema,
  number: githubNumberSchema,
  kind: z.enum(["issue", "pull"]),
  nodeId: z.string().min(1).max(200),
});
export const githubSourceSchema = githubDestinationSchema.extend({
  state: z.enum(["open", "closed", "merged"]),
  workIds: z.array(idSchema).max(50),
  pull: z
    .object({
      draft: z.boolean(),
      headSha: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/)
        .nullable(),
      mergedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .optional(),
});
export const githubActivitySchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      revision: z.number().int().positive(),
      title: z.string(),
      observedAt: z.iso.datetime({ offset: true }),
      github: githubSourceSchema,
    }),
  ),
  nextCursor: idSchema.nullable(),
});
const body = z
  .string()
  .min(1)
  .max(12000)
  .refine(
    (value) =>
      value.trim().length > 0 && !value.includes("\0") && !value.includes("\r"),
  );
export const githubCommentDraftSchema = z.object({
  mutationId: idSchema,
  githubSourceId: idSchema,
  body,
});
export const githubCommentRevisionSchema = githubCommentDraftSchema
  .omit({ githubSourceId: true })
  .extend({
    revision: z.number().int().positive().max(2147483647),
    expectedVersion: z.number().int().positive().max(2147483647),
  });
export const githubLinkSchema = z.object({
  mutationId: idSchema,
  workId: idSchema,
  linked: z.boolean(),
});
export const githubCommentCommandSchema = z.object({
  kind: z.literal("github.comment"),
  destination: githubDestinationSchema,
  body: z.string().min(1).max(12100),
  message: body,
});
export const githubRemoteReceiptSchema = z.object({
  id: githubIdSchema,
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
});
export const githubExecutionSchema = z.object({
  workspaceId: idSchema,
  installationId: githubIdSchema,
  command: githubCommentCommandSchema,
  started: z.boolean(),
  lease: idSchema,
});
export type GitHubDestination = z.infer<typeof githubDestinationSchema>;
export type GitHubSource = z.infer<typeof githubSourceSchema>;
export type GitHubRemoteReceipt = z.infer<typeof githubRemoteReceiptSchema>;
