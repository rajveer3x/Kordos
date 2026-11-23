import {
  bigint,
  boolean,
  check,
  date,
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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  foundationJobEffect,
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
    workId: uuid("work_id").notNull(),
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
      sql`${table.command}->>'kind' IS NOT DISTINCT FROM 'work.edit'`,
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
