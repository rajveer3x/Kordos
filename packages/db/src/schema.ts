import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
  },
  (table) => [index().on(table.workspaceId, table.name)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
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
    index().on(table.workspaceId, table.createdAt),
  ],
);
