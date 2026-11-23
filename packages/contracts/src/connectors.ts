import { z } from "zod";
import {
  githubIdSchema,
  githubRepositorySchema,
  githubSourceSchema,
} from "./github.js";
import { idSchema } from "./identity.js";

const instant = z.iso.datetime({ offset: true });
const label = z.string().trim().min(1).max(120);
const positive = z.number().int().positive().max(2147483647);
const opaque = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"));
export const connectorProviderSchema = z.enum(["fixture", "github"]);
export const connectorAudienceSchema = z.enum(["project", "private"]);
export const connectorStatusSchema = z.enum([
  "paused",
  "syncing",
  "healthy",
  "failed",
  "disconnected",
]);
export const connectorIssueSchema = z.enum([
  "credential_revoked",
  "provider_unavailable",
  "invalid_batch",
  "scope_unavailable",
]);
export const connectorScopeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/);
const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const mapping = z.object({
  scope: connectorScopeSchema,
  projectId: idSchema,
  audience: connectorAudienceSchema,
});
const create = mapping.extend({ mutationId: idSchema, label });
export const createConnectorSchema = z.discriminatedUnion("provider", [
  create.extend({ provider: z.literal("fixture"), token }),
  create.extend({
    provider: z.literal("github"),
    installationId: githubIdSchema,
    scope: githubRepositorySchema,
  }),
]);
const command = z.object({ mutationId: idSchema, expectedVersion: positive });
export const connectorCommandSchema = z.discriminatedUnion("action", [
  command.extend({ action: z.enum(["pause", "resume", "sync", "disconnect"]) }),
  command.extend({ action: z.literal("reconnect"), token: token.optional() }),
  command.merge(mapping).extend({ action: z.literal("map") }),
  command.extend({ action: z.literal("unmap"), mappingId: idSchema }),
]);
export type CreateConnector = z.infer<typeof createConnectorSchema>;
export type ConnectorCommand = z.infer<typeof connectorCommandSchema>;

const connectorMappingSchema = z.object({
  id: idSchema,
  projectId: idSchema.nullable(),
  projectName: z.string().nullable(),
  scope: connectorScopeSchema.nullable(),
  audience: connectorAudienceSchema,
  lastSuccess: instant.nullable(),
});
export const connectorSchema = z.object({
  id: idSchema,
  label,
  provider: connectorProviderSchema,
  status: connectorStatusSchema,
  version: positive,
  issue: connectorIssueSchema.nullable(),
  lastSuccess: instant.nullable(),
  retryAt: instant.nullable(),
  cleanupPending: z.boolean(),
  canConfigure: z.boolean(),
  mappings: z.array(connectorMappingSchema),
});
export const connectorDirectorySchema = z.object({
  enabled: z.boolean(),
  fixtureEnabled: z.boolean(),
  githubInstallations: z.array(githubIdSchema),
  items: z.array(connectorSchema),
  destinations: z.array(z.object({ id: idSchema, name: z.string() })),
});
export type Connector = z.infer<typeof connectorSchema>;
export const connectorSavedSchema = z.object({ id: idSchema });

const sourceFields = {
  externalId: opaque,
  revisionKey: opaque,
  observedAt: instant,
};
const providerLink = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  })
  .nullable();
export const connectorChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    ...sourceFields,
    kind: z.literal("upsert"),
    title: z.string().trim().min(1).max(240),
    body: z
      .string()
      .max(16000)
      .refine((value) => !value.includes("\0")),
    url: providerLink,
    github: githubSourceSchema.optional(),
  }),
  z.object({ ...sourceFields, kind: z.literal("delete") }),
]);
export const connectorDeliverySchema = z.object({
  scope: connectorScopeSchema,
  changes: z.array(connectorChangeSchema).max(100),
});
export const connectorPageSchema = z
  .object({
    changes: z.array(connectorChangeSchema).max(100),
    nextPage: opaque.nullable(),
    checkpoint: opaque.nullable(),
  })
  .refine(
    ({ nextPage, checkpoint }) => (nextPage === null) !== (checkpoint === null),
  );
export const connectorEntitlementSchema = z.object({
  audience: connectorAudienceSchema,
});
export type ConnectorChange = z.infer<typeof connectorChangeSchema>;

export const connectorQueue = "kordos-connectors";
export const connectorQueueJobSchema = z.object({
  id: idSchema,
  generation: positive,
});
export type ConnectorQueueJob = z.infer<typeof connectorQueueJobSchema>;
export const connectorClaimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cleanup"), lease: idSchema }),
  z.object({
    kind: z.enum(["sync", "delivery"]),
    lease: idSchema,
    workspaceId: idSchema,
    installationId: idSchema,
    provider: connectorProviderSchema,
    credential: z.string().nullable(),
    githubInstallation: githubIdSchema.nullable().optional(),
    scope: connectorScopeSchema,
    checkpoint: opaque.nullable(),
    delivery: connectorDeliverySchema.nullable(),
    githubDelivery: z
      .object({
        kind: z.enum(["issue", "pull"]),
        number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        repositoryId: githubIdSchema,
      })
      .nullable()
      .optional(),
  }),
]);

const sourceSummary = z.object({
  id: idSchema,
  title: z.string(),
  kind: z.enum(["mirror", "share"]),
  observedAt: instant,
});
export const connectorSourcesSchema = z.object({
  items: z.array(sourceSummary),
  nextCursor: idSchema.nullable(),
});
export const connectorSourceSchema = sourceSummary.extend({
  body: z.string(),
  url: providerLink,
  revision: positive,
  sourceId: idSchema,
  canShare: z.boolean(),
  canRevoke: z.boolean(),
  sharedBy: z.string().nullable(),
  github: githubSourceSchema.nullable().optional(),
  canDraftComment: z.boolean().optional(),
  canLinkWork: z.boolean().optional(),
  linkedWork: z
    .array(
      z.object({ id: idSchema, title: z.string(), confirmed: z.boolean() }),
    )
    .optional(),
});
export const connectorShareSchema = z.object({
  mutationId: idSchema,
  revision: positive,
  excerpt: z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => !value.includes("\0") && value.trim().length > 0),
});
export const revokeConnectorShareSchema = z.object({ mutationId: idSchema });
export type ConnectorSource = z.infer<typeof connectorSourceSchema>;
