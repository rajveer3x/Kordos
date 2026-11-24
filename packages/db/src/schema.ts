import {
  bigint,
  boolean,
  check,
  date,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  foundationJobEffect,
  searchEmbeddingDimensions,
  searchKinds,
  type FoundationJobEffect,
} from "@kordos/contracts";

export const foundationJobs = pgTable("foundation_jobs", {
  id: uuid().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const foundationJobEffects = pgTable(
  "foundation_job_effects",
  {
    jobId: uuid("job_id")
      .primaryKey()
      .references(() => foundationJobs.id),
    effect: text().$type<FoundationJobEffect>().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "foundation_job_effect_value",
      sql`${table.effect} = '${sql.raw(foundationJobEffect)}'`,
    ),
  ],
);

export const workspaceRole = pgEnum("workspace_role", [
  "viewer",
  "contributor",
  "admin",
]);

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
    name: text().notNull(),
    email: text(),
    emailVerified: boolean("email_verified").notNull(),
  },
  (table) => [unique().on(table.issuer, table.subject)],
);

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  timeZone: text("time_zone").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: workspaceRole().notNull(),
    version: integer().notNull().default(1),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index()
      .on(table.userId, table.workspaceId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text().notNull(),
    role: workspaceRole().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.acceptedBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "invitation_acceptance_pair",
      sql`(${table.acceptedAt} IS NULL) = (${table.acceptedBy} IS NULL)`,
    ),
  ],
);

export const projectVisibility = pgEnum("project_visibility", [
  "restricted",
  "workspace",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    description: text(),
    visibility: projectVisibility().notNull().default("restricted"),
    timeZone: text("time_zone").notNull().default("UTC"),
    workdays: smallint()
      .array()
      .notNull()
      .default(sql`ARRAY[1,2,3,4,5]::smallint[]`),
    nonworkingDates: date("nonworking_dates")
      .array()
      .notNull()
      .default(sql`'{}'::date[]`),
    version: integer().notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    graphVersion: integer("graph_version").notNull().default(1),
  },
  (table) => [
    index().on(table.workspaceId, table.name),
    unique().on(table.workspaceId, table.id),
    check(
      "projects_workdays",
      sql`cardinality(${table.workdays}) BETWEEN 1 AND 7
      AND ${table.workdays} <@ ARRAY[1,2,3,4,5,6,7]::smallint[]`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    projectId: uuid("project_id"),
    action: text().notNull(),
    targetId: uuid("target_id").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    details: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.actorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "audit_events_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    index().on(table.workspaceId, table.createdAt),
    index("audit_events_retention_idx")
      .on(table.workspaceId, table.createdAt, table.id)
      .where(sql`${table.redactedAt} IS NULL`),
    index("audit_events_project_activity_idx").on(
      table.workspaceId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
    index("audit_events_work_history_idx").on(
      table.workspaceId,
      table.projectId,
      table.targetId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const projectRole = pgEnum("project_role", [
  "viewer",
  "contributor",
  "lead",
]);
export const workStatus = pgEnum("work_status", [
  "backlog",
  "ready",
  "in_progress",
  "done",
]);
export const workKind = pgEnum("work_kind", ["task", "milestone"]);

export const projectMembers = pgTable(
  "project_members",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: projectRole().notNull(),
    version: integer().notNull().default(1),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.projectId, table.userId] }),
    foreignKey({
      name: "project_members_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "project_members_membership_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
  ],
);

export const workItems = pgTable(
  "work_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    title: text().notNull(),
    description: text(),
    kind: workKind().notNull(),
    status: workStatus().notNull(),
    ownerId: uuid("owner_id"),
    estimateDays: integer("estimate_days"),
    deadline: date(),
    deadlineRevision: integer("deadline_revision").notNull().default(1),
    commitment: date(),
    blockerReason: text("blocker_reason"),
    blockerOwnerId: uuid("blocker_owner_id"),
    blockerResolution: text("blocker_resolution"),
    version: integer().notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.workspaceId, table.projectId, table.id),
    foreignKey({
      name: "work_items_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "work_items_owner_fk",
      columns: [table.workspaceId, table.projectId, table.ownerId],
      foreignColumns: [
        projectMembers.workspaceId,
        projectMembers.projectId,
        projectMembers.userId,
      ],
    }),
    foreignKey({
      name: "work_items_blocker_owner_fk",
      columns: [table.workspaceId, table.projectId, table.blockerOwnerId],
      foreignColumns: [
        projectMembers.workspaceId,
        projectMembers.projectId,
        projectMembers.userId,
      ],
    }),
    check("work_items_estimate", sql`${table.estimateDays} BETWEEN 1 AND 3650`),
    check(
      "work_items_commitment",
      sql`${table.kind} = 'milestone' OR ${table.commitment} IS NULL`,
    ),
    check(
      "work_items_completion",
      sql`(${table.status} = 'done') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "work_items_blocker",
      sql`${table.blockerReason} IS NOT NULL OR
    (${table.blockerOwnerId} IS NULL AND ${table.blockerResolution} IS NULL)`,
    ),
    index("work_items_deadline_idx")
      .on(sql`coalesce(${table.deadline}, ${table.commitment})`)
      .where(
        sql`${table.archivedAt} IS NULL AND ${table.status} <> 'done' AND coalesce(${table.deadline}, ${table.commitment}) IS NOT NULL`,
      ),
    index("work_items_assigned_idx")
      .on(table.workspaceId, table.ownerId, table.id)
      .where(sql`${table.archivedAt} IS NULL AND ${table.status} <> 'done'`),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid()
      .primaryKey()
      .references(() => auditEvents.id),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    kind: text().notNull(),
    targetId: uuid("target_id").notNull(),
    request: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    commentSequence: bigint("comment_sequence", { mode: "bigint" }),
  },
  (table) => [
    unique().on(table.workspaceId, table.actorId, table.mutationId),
    foreignKey({
      name: "outbox_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "outbox_actor_fk",
      columns: [table.workspaceId, table.actorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    index("outbox_comment_feed_idx")
      .on(
        table.workspaceId,
        table.projectId,
        sql`(${table.request}->'subject')`,
        table.commentSequence,
      )
      .where(sql`${table.commentSequence} IS NOT NULL`),
    index("outbox_pending_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.deliveredAt} IS NULL`),
  ],
);

export const dependencyEdges = pgTable(
  "dependency_edges",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    predecessorId: uuid("predecessor_id").notNull(),
    successorId: uuid("successor_id").notNull(),
  },
  (table) => [
    unique("dependency_edges_pair").on(
      table.workspaceId,
      table.projectId,
      table.predecessorId,
      table.successorId,
    ),
    index("dependency_edges_incoming_idx").on(
      table.workspaceId,
      table.projectId,
      table.successorId,
    ),
    foreignKey({
      name: "dependency_edges_predecessor_fk",
      columns: [table.workspaceId, table.projectId, table.predecessorId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "dependency_edges_successor_fk",
      columns: [table.workspaceId, table.projectId, table.successorId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    check(
      "dependency_edges_distinct_items",
      sql`${table.predecessorId} <> ${table.successorId}`,
    ),
  ],
);

export const scenarios = pgTable(
  "scenarios",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    request: jsonb().notNull(),
    comparison: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("scenarios_actor_mutation").on(
      table.workspaceId,
      table.actorId,
      table.mutationId,
    ),
    foreignKey({
      name: "scenarios_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "scenarios_actor_fk",
      columns: [table.workspaceId, table.actorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    workId: uuid("work_id"),
    parentId: uuid("parent_id"),
    authorId: uuid("author_id").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    body: text().notNull(),
    mentionIds: uuid("mention_ids").array().notNull(),
    anchor: jsonb("anchor"),
    version: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
  },
  (table) => [
    unique("comments_project_id_unique").on(
      table.workspaceId,
      table.projectId,
      table.id,
    ),
    unique("comments_subject_id_unique").on(
      table.workspaceId,
      table.projectId,
      table.subjectKind,
      table.subjectId,
      table.id,
    ),
    foreignKey({
      name: "comments_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "comments_work_fk",
      columns: [table.workspaceId, table.projectId, table.workId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "comments_parent_fk",
      columns: [
        table.workspaceId,
        table.projectId,
        table.subjectKind,
        table.subjectId,
        table.parentId,
      ],
      foreignColumns: [
        table.workspaceId,
        table.projectId,
        table.subjectKind,
        table.subjectId,
        table.id,
      ],
    }),
    foreignKey({
      name: "comments_author_fk",
      columns: [table.workspaceId, table.authorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "comments_resolver_fk",
      columns: [table.workspaceId, table.resolvedBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "comments_subject",
      sql`(
      (${table.subjectKind} = 'project' AND ${table.subjectId} = ${table.projectId} AND ${table.workId} IS NULL)
      OR (${table.subjectKind} = 'task' AND ${table.workId} IS NOT NULL AND ${table.workId} = ${table.subjectId})
      OR (${table.subjectKind} IN ('document', 'meeting') AND ${table.workId} IS NULL)
    )`,
    ),
    check(
      "comments_content",
      sql`char_length(btrim(${table.body})) BETWEEN 1 AND 4000
      AND cardinality(${table.mentionIds}) <= 20 AND ${table.version} > 0`,
    ),
    check(
      "comments_resolution",
      sql`(${table.resolvedAt} IS NULL AND ${table.resolvedBy} IS NULL)
      OR (${table.parentId} IS NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.resolvedBy} IS NOT NULL)`,
    ),
    index("comments_subject_threads_idx").on(
      table.workspaceId,
      table.projectId,
      table.subjectKind,
      table.subjectId,
      table.parentId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    revision: integer("revision").notNull().default(1),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("documents_scope_unique").on(t.workspaceId, t.projectId, t.id),
    foreignKey({
      name: "documents_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    documentId: uuid("document_id").notNull(),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    authorId: uuid("author_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    baseRevision: integer("base_revision"),
    restoredFrom: integer("restored_from"),
  },
  (t) => [
    primaryKey({
      columns: [t.workspaceId, t.projectId, t.documentId, t.revision],
    }),
    foreignKey({
      name: "document_versions_document_fk",
      columns: [t.workspaceId, t.projectId, t.documentId],
      foreignColumns: [
        documents.workspaceId,
        documents.projectId,
        documents.id,
      ],
    }),
    foreignKey({
      name: "document_versions_author_fk",
      columns: [t.workspaceId, t.authorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "document_versions_base_fk",
      columns: [t.workspaceId, t.projectId, t.documentId, t.baseRevision],
      foreignColumns: [t.workspaceId, t.projectId, t.documentId, t.revision],
    }),
    foreignKey({
      name: "document_versions_restore_fk",
      columns: [t.workspaceId, t.projectId, t.documentId, t.restoredFrom],
      foreignColumns: [t.workspaceId, t.projectId, t.documentId, t.revision],
    }),
  ],
);

export const documentAttachments = pgTable(
  "document_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    documentId: uuid("document_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [
    unique("document_attachments_mutation_unique").on(
      t.workspaceId,
      t.actorId,
      t.mutationId,
    ),
    index("document_attachments_document_idx").on(
      t.workspaceId,
      t.projectId,
      t.documentId,
    ),
    foreignKey({
      name: "document_attachments_document_fk",
      columns: [t.workspaceId, t.projectId, t.documentId],
      foreignColumns: [
        documents.workspaceId,
        documents.projectId,
        documents.id,
      ],
    }),
    foreignKey({
      name: "document_attachments_actor_fk",
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    question: text("question").notNull(),
    conclusion: text("conclusion").notNull(),
    accountableId: uuid("accountable_id").notNull(),
    effectiveDate: date("effective_date").notNull(),
    evidence: jsonb("evidence").notNull(),
    supersedesId: uuid("supersedes_id"),
    authorId: uuid("author_id").notNull(),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    unique("decisions_scope_unique").on(t.workspaceId, t.projectId, t.id),
    index("decisions_project_date_idx").on(
      t.workspaceId,
      t.projectId,
      t.effectiveDate,
    ),
    uniqueIndex("decisions_one_successor_idx")
      .on(t.workspaceId, t.projectId, t.supersedesId)
      .where(sql.raw("confirmed_at IS NOT NULL AND supersedes_id IS NOT NULL")),
    foreignKey({
      name: "decisions_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "decisions_accountable_fk",
      columns: [t.workspaceId, t.accountableId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "decisions_author_fk",
      columns: [t.workspaceId, t.authorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "decisions_confirmer_fk",
      columns: [t.workspaceId, t.confirmedBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "decisions_supersedes_fk",
      columns: [t.workspaceId, t.projectId, t.supersedesId],
      foreignColumns: [t.workspaceId, t.projectId, t.id],
    }),
  ],
);

export const briefJobs = pgTable(
  "brief_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    sourceRevision: integer("source_revision").notNull().default(1),
    requesterId: uuid("requester_id").notNull(),
    timeZone: text("time_zone").notNull(),
    status: text().notNull().default("queued"),
    attempt: integer().notNull().default(1),
    version: integer().notNull().default(1),
    candidates: jsonb(),
    failure: text(),
    leaseId: uuid("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("brief_jobs_source_unique").on(
      t.workspaceId,
      t.projectId,
      t.documentId,
      t.sourceRevision,
    ),
    unique("brief_jobs_scope_unique").on(t.workspaceId, t.projectId, t.id),
    foreignKey({
      name: "brief_jobs_source_fk",
      columns: [t.workspaceId, t.projectId, t.documentId, t.sourceRevision],
      foreignColumns: [
        documentVersions.workspaceId,
        documentVersions.projectId,
        documentVersions.documentId,
        documentVersions.revision,
      ],
    }),
    foreignKey({
      name: "brief_jobs_requester_fk",
      columns: [t.workspaceId, t.requesterId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "brief_jobs_attempt",
      sql`${t.attempt} BETWEEN 1 AND 3 AND ${t.version} > 0`,
    ),
    check(
      "brief_jobs_status",
      sql`${t.status} IN ('queued', 'running', 'ready', 'failed')
      AND (${t.status} = 'running') = (${t.leaseId} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)
      AND (${t.status} = 'ready') = (${t.candidates} IS NOT NULL)
      AND (${t.status} = 'failed') = (${t.failure} IS NOT NULL)`,
    ),
    index("brief_jobs_project_date_idx").on(
      t.workspaceId,
      t.projectId,
      t.createdAt,
      t.id,
    ),
    index("brief_jobs_pending_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    organizerId: uuid("organizer_id").notNull(),
    jobActorId: uuid("job_actor_id").notNull(),
    title: text().notNull(),
    agenda: text(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    timeZone: text("time_zone").notNull(),
    retentionDays: integer("retention_days").notNull(),
    version: integer().notNull().default(1),
    transcriptRevision: integer("transcript_revision").notNull().default(0),
    generation: integer().notNull().default(1),
    attempt: integer().notNull().default(0),
    status: text().notNull().default("empty"),
    mode: text(),
    failure: text(),
    pendingText: text("pending_text"),
    calendarSourceId: uuid("calendar_source_id"),
    calendarRevision: integer("calendar_revision"),
    calendarCanceled: boolean("calendar_canceled").notNull().default(false),
    lease: uuid(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
  },
  (t) => [
    unique("meetings_calendar_source_unique").on(t.calendarSourceId),
    foreignKey({
      name: "meetings_calendar_source_fk",
      columns: [t.workspaceId, t.projectId, t.calendarSourceId],
      foreignColumns: [
        sourceObjects.workspaceId,
        sourceObjects.projectId,
        sourceObjects.id,
      ],
    }),
    check(
      "meetings_calendar_source_state",
      sql`(${t.calendarSourceId} IS NULL AND ${t.calendarRevision} IS NULL AND NOT ${t.calendarCanceled})
      OR (${t.calendarSourceId} IS NOT NULL AND ${t.calendarRevision} IS NOT NULL AND ${t.calendarRevision} > 0)`,
    ),
    unique("meetings_scope_unique").on(t.workspaceId, t.projectId, t.id),
    foreignKey({
      name: "meetings_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "meetings_organizer_fk",
      columns: [t.workspaceId, t.organizerId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "meetings_actor_fk",
      columns: [t.workspaceId, t.jobActorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    index("meetings_project_date_idx").on(
      t.workspaceId,
      t.projectId,
      t.startsAt,
      t.id,
    ),
    index("meetings_queue_idx")
      .on(t.leaseUntil, t.id)
      .where(sql`${t.status} IN ('queued','processing')`),
    check(
      "meetings_state",
      sql`${t.status} IN ('empty','queued','processing','ready','failed')
    AND ${t.attempt} BETWEEN 0 AND 3 AND ${t.retentionDays} IN (7,30,90)
    AND (${t.status} = 'processing') = (${t.lease} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)`,
    ),
  ],
);

export const meetingMedia = pgTable(
  "meeting_media",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    extension: text().notNull(),
    digest: text().notNull(),
    size: integer().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("meeting_media_scope_unique").on(
      t.workspaceId,
      t.projectId,
      t.meetingId,
      t.id,
    ),
    unique("meeting_media_mutation_unique").on(
      t.workspaceId,
      t.actorId,
      t.mutationId,
    ),
    uniqueIndex("meeting_media_active_idx")
      .on(t.workspaceId, t.projectId, t.meetingId)
      .where(sql`${t.removedAt} IS NULL`),
    index("meeting_media_expiry_idx")
      .on(t.expiresAt, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      name: "meeting_media_meeting_fk",
      columns: [t.workspaceId, t.projectId, t.meetingId],
      foreignColumns: [meetings.workspaceId, meetings.projectId, meetings.id],
    }),
    foreignKey({
      name: "meeting_media_actor_fk",
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "meeting_media_metadata",
      sql`${t.extension} IN ('wav','mp3','m4a') AND ${t.size} BETWEEN 1 AND 20971520`,
    ),
  ],
);

export const meetingTranscripts = pgTable(
  "meeting_transcripts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    revision: integer().notNull(),
    mediaId: uuid("media_id"),
    authorId: uuid("author_id").notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    segments: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("meeting_transcripts_retention_idx")
      .on(t.workspaceId, t.createdAt, t.meetingId, t.revision)
      .where(sql`${t.purgedAt} IS NULL`),
    primaryKey({
      name: "meeting_transcripts_pk",
      columns: [t.workspaceId, t.projectId, t.meetingId, t.revision],
    }),
    foreignKey({
      name: "meeting_transcripts_meeting_fk",
      columns: [t.workspaceId, t.projectId, t.meetingId],
      foreignColumns: [meetings.workspaceId, meetings.projectId, meetings.id],
    }),
    foreignKey({
      name: "meeting_transcripts_media_fk",
      columns: [t.workspaceId, t.projectId, t.meetingId, t.mediaId],
      foreignColumns: [
        meetingMedia.workspaceId,
        meetingMedia.projectId,
        meetingMedia.meetingId,
        meetingMedia.id,
      ],
    }),
    foreignKey({
      name: "meeting_transcripts_actor_fk",
      columns: [t.workspaceId, t.authorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
  ],
);

export const meetingItems = pgTable(
  "meeting_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    meetingId: uuid("meeting_id").notNull(),
    key: text().notNull(),
    transcriptRevision: integer("transcript_revision").notNull(),
    suggestion: jsonb().notNull(),
    reviewedValues: jsonb("reviewed_values"),
    status: text().notNull().default("suggested"),
    version: integer().notNull().default(1),
    proposalId: uuid("proposal_id"),
    workId: uuid("work_id"),
    decisionId: uuid("decision_id"),
  },
  (t) => [
    unique("meeting_items_scope_unique").on(t.workspaceId, t.projectId, t.id),
    unique("meeting_items_key_unique").on(
      t.workspaceId,
      t.projectId,
      t.meetingId,
      t.key,
    ),
    unique("meeting_items_work_unique").on(t.workId),
    unique("meeting_items_decision_unique").on(t.decisionId),
    foreignKey({
      name: "meeting_items_transcript_fk",
      columns: [t.workspaceId, t.projectId, t.meetingId, t.transcriptRevision],
      foreignColumns: [
        meetingTranscripts.workspaceId,
        meetingTranscripts.projectId,
        meetingTranscripts.meetingId,
        meetingTranscripts.revision,
      ],
    }),
    foreignKey({
      name: "meeting_items_work_fk",
      columns: [t.workspaceId, t.projectId, t.workId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "meeting_items_decision_fk",
      columns: [t.workspaceId, t.projectId, t.decisionId],
      foreignColumns: [
        decisions.workspaceId,
        decisions.projectId,
        decisions.id,
      ],
    }),
    check(
      "meeting_items_state",
      sql`${t.status} IN ('suggested','submitted','stale','accepted','rejected')`,
    ),
  ],
);

export const proposalStatus = pgEnum("proposal_status", [
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

export const proposals = pgTable(
  "proposals",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    workId: uuid("work_id"),
    briefId: uuid("brief_id"),
    meetingItemId: uuid("meeting_item_id"),
    githubSourceId: uuid("github_source_id"),
    requesterId: uuid("requester_id").notNull(),
    status: proposalStatus().notNull().default("draft"),
    revision: integer().notNull().default(1),
    version: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewerId: uuid("reviewer_id"),
    reason: text(),
  },
  (table) => [
    unique().on(table.workspaceId, table.projectId, table.id),
    foreignKey({
      name: "proposals_meeting_item_fk",
      columns: [table.workspaceId, table.projectId, table.meetingItemId],
      foreignColumns: [
        meetingItems.workspaceId,
        meetingItems.projectId,
        meetingItems.id,
      ],
    }),
    foreignKey({
      name: "proposals_github_source_fk",
      columns: [table.workspaceId, table.projectId, table.githubSourceId],
      foreignColumns: [
        sourceObjects.workspaceId,
        sourceObjects.projectId,
        sourceObjects.id,
      ],
    }),
    index("proposals_github_source_idx").on(table.githubSourceId),
    index("proposals_meeting_item_idx").on(table.meetingItemId),
    unique("proposals_brief_unique").on(table.briefId),
    check(
      "proposals_one_target",
      sql`num_nonnulls(${table.workId}, ${table.briefId}, ${table.meetingItemId}, ${table.githubSourceId}) = 1`,
    ),
    foreignKey({
      name: "proposals_brief_fk",
      columns: [table.workspaceId, table.projectId, table.briefId],
      foreignColumns: [
        briefJobs.workspaceId,
        briefJobs.projectId,
        briefJobs.id,
      ],
    }),
    foreignKey({
      name: "proposals_work_fk",
      columns: [table.workspaceId, table.projectId, table.workId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "proposals_requester_fk",
      columns: [table.workspaceId, table.requesterId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "proposals_reviewer_fk",
      columns: [table.workspaceId, table.reviewerId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    index("proposals_workspace_date_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const proposalRevisions = pgTable(
  "proposal_revisions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    revision: integer().notNull(),
    authorId: uuid("author_id").notNull(),
    targetVersion: integer("target_version").notNull(),
    command: jsonb().notNull(),
    before: jsonb().notNull(),
    evidence: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "proposal_revisions_pk",
      columns: [
        table.workspaceId,
        table.projectId,
        table.proposalId,
        table.revision,
      ],
    }),
    foreignKey({
      name: "proposal_revisions_proposal_fk",
      columns: [table.workspaceId, table.projectId, table.proposalId],
      foreignColumns: [
        proposals.workspaceId,
        proposals.projectId,
        proposals.id,
      ],
    }),
    foreignKey({
      name: "proposal_revisions_author_fk",
      columns: [table.workspaceId, table.authorId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "proposal_revisions_command",
      sql`coalesce(${table.command}->>'kind' IN ('work.edit', 'plan.create', 'meeting.accept', 'github.comment', 'work.consolidate'), false)`,
    ),
  ],
);

export const planWorkItems = pgTable(
  "plan_work_items",
  {
    workId: uuid("work_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    revision: integer().notNull(),
    candidateId: uuid("candidate_id").notNull(),
  },
  (t) => [
    foreignKey({
      name: "plan_work_items_work_fk",
      columns: [t.workspaceId, t.projectId, t.workId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "plan_work_items_revision_fk",
      columns: [t.workspaceId, t.projectId, t.proposalId, t.revision],
      foreignColumns: [
        proposalRevisions.workspaceId,
        proposalRevisions.projectId,
        proposalRevisions.proposalId,
        proposalRevisions.revision,
      ],
    }),
    unique("plan_work_items_candidate_unique").on(
      t.workspaceId,
      t.projectId,
      t.proposalId,
      t.revision,
      t.candidateId,
    ),
  ],
);

export const executions = pgTable(
  "executions",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    revision: integer().notNull(),
    reviewerId: uuid("reviewer_id").notNull(),
    authority: jsonb().notNull(),
    status: proposalStatus().notNull().default("approved"),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    issue: text(),
    writeMutationId: uuid("write_mutation_id").notNull().defaultRandom(),
    githubStartedAt: timestamp("github_started_at", { withTimezone: true }),
    githubLease: uuid("github_lease"),
    githubNextAt: timestamp("github_next_at", { withTimezone: true }),
    githubAttempts: integer("github_attempts").notNull().default(0),
    githubRemote: jsonb("github_remote"),
    approvalAuditId: uuid("approval_audit_id")
      .notNull()
      .references(() => auditEvents.id),
    outcomeAuditId: uuid("outcome_audit_id").references(() => auditEvents.id),
    effectEventId: uuid("effect_event_id")
      .unique()
      .references(() => auditEvents.id),
  },
  (table) => [
    unique().on(
      table.workspaceId,
      table.projectId,
      table.proposalId,
      table.revision,
    ),
    foreignKey({
      name: "executions_revision_fk",
      columns: [
        table.workspaceId,
        table.projectId,
        table.proposalId,
        table.revision,
      ],
      foreignColumns: [
        proposalRevisions.workspaceId,
        proposalRevisions.projectId,
        proposalRevisions.proposalId,
        proposalRevisions.revision,
      ],
    }),
    foreignKey({
      name: "executions_reviewer_fk",
      columns: [table.workspaceId, table.reviewerId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "executions_status",
      sql`${table.status} NOT IN ('draft', 'pending', 'rejected')`,
    ),
    index("executions_pending_idx")
      .on(table.approvedAt, table.id)
      .where(sql`${table.status} IN ('approved', 'applying')`),
  ],
);

export const riskCommentJobs = pgTable(
  "risk_comment_jobs",
  {
    id: uuid()
      .primaryKey()
      .references(() => outbox.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("risk_comment_jobs_pending_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

export const riskFindings = pgTable(
  "risk_findings",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    commentId: uuid("comment_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    sourceAt: timestamp("source_at", { withTimezone: true }).notNull(),
    inputRevision: text("input_revision").notNull(),
    asOf: date("as_of").notNull(),
    calendar: jsonb().notNull(),
    assessment: jsonb().notNull(),
    status: text().notNull().default("open"),
    version: integer().notNull().default(1),
    previousId: uuid("previous_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("risk_findings_scope_unique").on(t.workspaceId, t.projectId, t.id),
    foreignKey({
      name: "risk_findings_comment_fk",
      columns: [t.workspaceId, t.projectId, t.commentId],
      foreignColumns: [comments.workspaceId, comments.projectId, comments.id],
    }),
    foreignKey({
      name: "risk_findings_previous_fk",
      columns: [t.workspaceId, t.projectId, t.previousId],
      foreignColumns: [t.workspaceId, t.projectId, t.id],
    }),
    unique("risk_findings_successor_unique").on(t.previousId),
    uniqueIndex("risk_findings_current_comment_idx")
      .on(t.workspaceId, t.projectId, t.commentId)
      .where(sql`${t.status} <> 'superseded'`),
    index("risk_findings_project_date_idx").on(
      t.workspaceId,
      t.projectId,
      t.createdAt,
      t.id,
    ),
    check(
      "risk_findings_status",
      sql`${t.status} IN ('open', 'acknowledged', 'resolved', 'superseded')`,
    ),
  ],
);

export const riskReplans = pgTable(
  "risk_replans",
  {
    proposalId: uuid("proposal_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    findingId: uuid("finding_id").notNull(),
  },
  (t) => [
    foreignKey({
      name: "risk_replans_proposal_fk",
      columns: [t.workspaceId, t.projectId, t.proposalId],
      foreignColumns: [
        proposals.workspaceId,
        proposals.projectId,
        proposals.id,
      ],
    }),
    foreignKey({
      name: "risk_replans_finding_fk",
      columns: [t.workspaceId, t.projectId, t.findingId],
      foreignColumns: [
        riskFindings.workspaceId,
        riskFindings.projectId,
        riskFindings.id,
      ],
    }),
    index("risk_replans_finding_idx").on(
      t.workspaceId,
      t.projectId,
      t.findingId,
    ),
  ],
);

export const inboxPreferences = pgTable(
  "inbox_preferences",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    version: integer().notNull(),
    settings: jsonb().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    foreignKey({
      name: "inbox_preferences_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
  ],
);

export const inboxEntries = pgTable(
  "inbox_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    reason: text().notNull(),
    revision: integer().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    emailAt: timestamp("email_at", { withTimezone: true }),
    emailSlot: date("email_slot"),
    emailAttempts: integer("email_attempts").notNull().default(0),
    emailResult: text("email_result"),
  },
  (table) => [
    unique("inbox_entries_effect_unique").on(
      table.workspaceId,
      table.recipientId,
      table.subjectId,
      table.reason,
      table.revision,
    ),
    foreignKey({
      name: "inbox_entries_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "inbox_entries_recipient_fk",
      columns: [table.workspaceId, table.recipientId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "inbox_entries_reason",
      sql`${table.reason} IN ('assignment','mention','review','risk','due','overdue','escalation')`,
    ),
    check(
      "inbox_entries_email_result",
      sql`${table.emailResult} IN ('sent','failed','suppressed')`,
    ),
    index("inbox_entries_recipient_idx")
      .on(table.workspaceId, table.recipientId, table.deliveredAt, table.id)
      .where(sql`${table.deliveredAt} IS NOT NULL`),
    index("inbox_entries_pending_idx")
      .on(table.nextAt, table.id)
      .where(sql`${table.deliveredAt} IS NULL AND ${table.canceledAt} IS NULL`),
    index("inbox_entries_email_idx")
      .on(table.emailAt, table.id)
      .where(
        sql`${table.emailAt} IS NOT NULL AND ${table.emailResult} IS NULL`,
      ),
  ],
);

export const connectorInstallations = pgTable(
  "connector_installations",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    label: text().notNull(),
    provider: text().notNull(),
    githubInstallation: text("github_installation"),
    googleSubject: text("google_subject"),
    credential: text(),
    state: text().notNull().default("enabled"),
    version: integer().notNull().default(1),
    issue: text(),
    lastSuccess: timestamp("last_success", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.workspaceId, table.id),
    foreignKey({
      name: "connector_installations_owner_fk",
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    check(
      "connector_installations_provider",
      sql`(${table.provider} = 'fixture' AND ${table.githubInstallation} IS NULL AND ${table.googleSubject} IS NULL)
        OR (${table.provider} = 'github' AND ${table.githubInstallation} ~ '^[1-9][0-9]{0,15}$' AND ${table.githubInstallation} IS NOT NULL AND ${table.googleSubject} IS NULL)
        OR (${table.provider} IN ('calendar','gmail') AND ${table.githubInstallation} IS NULL AND ${table.googleSubject} ~ '^[A-Za-z0-9_-]{1,255}$' AND ${table.googleSubject} IS NOT NULL)`,
    ),
    uniqueIndex("connector_installations_active_github")
      .on(table.workspaceId, table.githubInstallation)
      .where(
        sql`${table.state} <> 'disconnected' AND ${table.githubInstallation} IS NOT NULL`,
      ),
    check(
      "connector_installations_state",
      sql`${table.state} IN ('enabled','paused','disconnected')`,
    ),
  ],
);
export const connectorMappings = pgTable(
  "connector_mappings",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    scope: text().notNull(),
    projectId: uuid("project_id").notNull(),
    audience: text().notNull(),
    providerAudience: text("provider_audience"),
    githubRepository: text("github_repository"),
    verifiedUntil: timestamp("verified_until", { withTimezone: true }),
    checkpoint: text(),
    lastSuccess: timestamp("last_success", { withTimezone: true }),
    nextSync: timestamp("next_sync", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.workspaceId, table.installationId, table.id),
    unique().on(
      table.workspaceId,
      table.installationId,
      table.id,
      table.projectId,
    ),
    uniqueIndex("connector_mappings_active_scope")
      .on(table.installationId, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    foreignKey({
      name: "connector_mappings_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [
        connectorInstallations.workspaceId,
        connectorInstallations.id,
      ],
    }),
    foreignKey({
      name: "connector_mappings_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    check(
      "connector_mappings_audience",
      sql`${table.audience} IN ('project','private') AND ${table.providerAudience} IN ('project','private')`,
    ),
  ],
);
export const connectorJobs = pgTable(
  "connector_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    mappingId: uuid("mapping_id"),
    kind: text().notNull(),
    state: text().notNull().default("queued"),
    deliveryId: text("delivery_id"),
    deliveryHash: text("delivery_hash"),
    payload: jsonb(),
    attempts: integer().notNull().default(0),
    generation: integer().notNull().default(1),
    lease: uuid(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.installationId, table.deliveryId),
    uniqueIndex("connector_jobs_active_sync")
      .on(table.mappingId)
      .where(
        sql`${table.kind} = 'sync' AND ${table.state} IN ('queued','running')`,
      ),
    index("connector_jobs_pending")
      .on(table.availableAt, table.installationId, table.id)
      .where(sql`${table.state} IN ('queued','running')`),
    foreignKey({
      name: "connector_jobs_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [
        connectorInstallations.workspaceId,
        connectorInstallations.id,
      ],
    }),
    foreignKey({
      name: "connector_jobs_mapping_fk",
      columns: [table.workspaceId, table.installationId, table.mappingId],
      foreignColumns: [
        connectorMappings.workspaceId,
        connectorMappings.installationId,
        connectorMappings.id,
      ],
    }),
    check(
      "connector_jobs_state",
      sql`${table.state} IN ('queued','running','succeeded','failed','canceled')`,
    ),
    check(
      "connector_jobs_kind",
      sql`(${table.kind} = 'cleanup' OR ${table.mappingId} IS NOT NULL)
      AND ${table.kind} IN ('sync','delivery','cleanup','outbound')`,
    ),
  ],
);
export const sourceObjects = pgTable(
  "source_objects",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    mappingId: uuid("mapping_id").notNull(),
    projectId: uuid("project_id").notNull(),
    externalId: text("external_id").notNull(),
    revision: integer().notNull().default(0),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.workspaceId, table.projectId, table.id),
    unique().on(table.mappingId, table.externalId),
    foreignKey({
      name: "source_objects_mapping_fk",
      columns: [
        table.workspaceId,
        table.installationId,
        table.mappingId,
        table.projectId,
      ],
      foreignColumns: [
        connectorMappings.workspaceId,
        connectorMappings.installationId,
        connectorMappings.id,
        connectorMappings.projectId,
      ],
    }),
  ],
);
export const sourceRevisions = pgTable(
  "source_revisions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    revision: integer().notNull(),
    revisionKey: text("revision_key").notNull(),
    github: jsonb(),
    calendarStart: timestamp("calendar_start", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    title: text(),
    body: text(),
    url: text(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.projectId,
        table.sourceId,
        table.revision,
      ],
    }),
    index("source_revisions_retention_idx")
      .on(table.workspaceId, table.observedAt, table.sourceId, table.revision)
      .where(sql`${table.purgedAt} IS NULL AND ${table.title} IS NOT NULL`),
    unique().on(table.sourceId, table.revisionKey),
    foreignKey({
      name: "source_revisions_source_fk",
      columns: [table.workspaceId, table.projectId, table.sourceId],
      foreignColumns: [
        sourceObjects.workspaceId,
        sourceObjects.projectId,
        sourceObjects.id,
      ],
    }),
  ],
);
export const connectorShares = pgTable(
  "connector_shares",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    revision: integer().notNull(),
    sharerId: uuid("sharer_id").notNull(),
    title: text().notNull(),
    excerpt: text().notNull(),
    url: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "connector_shares_revision_fk",
      columns: [
        table.workspaceId,
        table.projectId,
        table.sourceId,
        table.revision,
      ],
      foreignColumns: [
        sourceRevisions.workspaceId,
        sourceRevisions.projectId,
        sourceRevisions.sourceId,
        sourceRevisions.revision,
      ],
    }),
    foreignKey({
      name: "connector_shares_sharer_fk",
      columns: [table.workspaceId, table.sharerId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    index("connector_shares_retention_idx")
      .on(table.workspaceId, table.revokedAt, table.id)
      .where(sql`${table.purgedAt} IS NULL AND ${table.revokedAt} IS NOT NULL`),
    index("connector_shares_project_idx").on(
      table.workspaceId,
      table.projectId,
      table.id,
    ),
  ],
);

export const githubWorkLinks = pgTable(
  "github_work_links",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    workId: uuid("work_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.projectId, t.sourceId, t.workId] }),
    foreignKey({
      name: "github_work_links_source_fk",
      columns: [t.workspaceId, t.projectId, t.sourceId],
      foreignColumns: [
        sourceObjects.workspaceId,
        sourceObjects.projectId,
        sourceObjects.id,
      ],
    }),
    foreignKey({
      name: "github_work_links_work_fk",
      columns: [t.workspaceId, t.projectId, t.workId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    index("github_work_links_work_idx").on(
      t.workspaceId,
      t.projectId,
      t.workId,
    ),
  ],
);

export const searchKind = pgEnum("search_kind", searchKinds);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const searchOutbox = pgTable(
  "search_outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    kind: searchKind().notNull(),
    sourceId: uuid("source_id").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.projectId, t.kind, t.sourceId] }),
    foreignKey({
      name: "search_outbox_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("cascade"),
    index("search_outbox_queue_idx").on(t.queuedAt),
  ],
);

export const searchChunks = pgTable(
  "search_chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    kind: searchKind().notNull(),
    sourceId: uuid("source_id").notNull(),
    revision: integer().notNull(),
    ordinal: integer().notNull(),
    title: text().notNull(),
    passage: text().notNull(),
    attribution: text().notNull(),
    attributedDate: date("attributed_date"),
    ownerId: uuid("owner_id"),
    citation: jsonb(),
    externalId: text("external_id"),
    exactIds: text("exact_ids").array().notNull(),
    audience: text().notNull(),
    terms: tsvector().notNull().generatedAlwaysAs(sql`
      setweight(to_tsvector('english', title), 'A') ||
      setweight(to_tsvector('english', passage), 'B')
    `),
    embedding: vector({ dimensions: searchEmbeddingDimensions }),
    model: text(),
    embeddingLease: uuid("embedding_lease"),
    embedAfter: timestamp("embed_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "search_chunks_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("cascade"),
    unique("search_chunk_source_ordinal").on(
      t.workspaceId,
      t.projectId,
      t.kind,
      t.sourceId,
      t.ordinal,
    ),
    check("search_chunk_audience", sql`${t.audience} IN ('project', 'owner')`),
    index("search_chunk_terms_idx").using("gin", t.terms),
    index("search_chunk_exact_idx").using("gin", t.exactIds),
    index("search_chunk_embedding_queue_idx")
      .on(t.model, t.embedAfter, t.id)
      .where(sql`${t.audience} = 'project'`),
  ],
);

export const projectWeeklies = pgTable(
  "project_weeklies",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    period: date().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    snapshot: jsonb().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.projectId, table.period] }),
    foreignKey({
      name: "project_weeklies_project_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("cascade"),
  ],
);

export const workRelations = pgTable(
  "work_relations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    firstId: uuid("first_id").notNull(),
    secondId: uuid("second_id").notNull(),
    consolidatedInto: uuid("consolidated_into"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.projectId,
        table.firstId,
        table.secondId,
      ],
    }),
    index("work_relations_second_idx").on(
      table.workspaceId,
      table.projectId,
      table.secondId,
    ),
    foreignKey({
      name: "work_relations_first_fk",
      columns: [table.workspaceId, table.projectId, table.firstId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "work_relations_second_fk",
      columns: [table.workspaceId, table.projectId, table.secondId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    check("work_relations_ordered", sql`${table.firstId} < ${table.secondId}`),
    check(
      "work_relations_target",
      sql`${table.consolidatedInto} IN (${table.firstId}, ${table.secondId})`,
    ),
  ],
);

export const duplicateDismissals = pgTable(
  "duplicate_dismissals",
  {
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    firstId: uuid("first_id").notNull(),
    secondId: uuid("second_id").notNull(),
    firstVersion: integer("first_version").notNull(),
    secondVersion: integer("second_version").notNull(),
  },
  (table) => [
    primaryKey({
      name: "duplicate_dismissals_pk",
      columns: [
        table.workspaceId,
        table.projectId,
        table.firstId,
        table.secondId,
        table.firstVersion,
        table.secondVersion,
      ],
    }),
    foreignKey({
      name: "duplicate_dismissals_first_fk",
      columns: [table.workspaceId, table.projectId, table.firstId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    foreignKey({
      name: "duplicate_dismissals_second_fk",
      columns: [table.workspaceId, table.projectId, table.secondId],
      foreignColumns: [
        workItems.workspaceId,
        workItems.projectId,
        workItems.id,
      ],
    }),
    check(
      "duplicate_dismissals_ordered",
      sql`${table.firstId} < ${table.secondId}`,
    ),
  ],
);

export const workspaceRetention = pgTable(
  "workspace_retention",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer().notNull().default(1),
    audioDays: integer("audio_days").notNull().default(90),
    transcriptDays: integer("transcript_days").notNull().default(365),
    importedDays: integer("imported_days").notNull().default(365),
    logDays: integer("log_days").notNull().default(90),
    accessEpoch: bigint("access_epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "workspace_retention_days",
      sql`
      ${table.audioDays} BETWEEN 1 AND 90 AND ${table.transcriptDays} BETWEEN 1 AND 3650
      AND ${table.importedDays} BETWEEN 1 AND 3650 AND ${table.logDays} BETWEEN 1 AND 365`,
    ),
  ],
);
