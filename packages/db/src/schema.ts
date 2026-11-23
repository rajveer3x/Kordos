import {
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
