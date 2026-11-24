# Runtime and data architecture

## Components and ownership

| Boundary | Technology | Owns |
|---|---|---|
| apps/web | React, TypeScript, Vite, React Router, TanStack Query, Tailwind, Radix UI, React Flow | Routes, accessible controls, presentation, optimistic state, graph and list views |
| apps/api | Node.js, Fastify, Zod, OpenAPI, Socket.IO, Auth0 OIDC | Sessions, authenticated queries and commands, provider ingress, scoped live rooms |
| apps/worker | Node.js, BullMQ, Redis | Outbox delivery, extraction, forecasts, indexing, reminders, reconciliation and external executions |
| packages/domain | TypeScript | Calendar math, graph traversal, proposal transitions, command policy and authorized action definitions |
| packages/contracts | TypeScript and Zod | DTO schemas, versions, typed events, public error codes |
| packages/db | PostgreSQL, Drizzle, SQL migrations, pgvector | Durable truth, constraints, row policies, full-text and vector indexes |
| Private storage and providers | S3-compatible storage, Groq and OpenAI adapters, GitHub App, Google OAuth | Authorized media and attachments, transcription, text, embeddings, scoped connector operations |

Use pnpm workspaces and Docker Compose in development. Pin compatible dependency versions in the lockfile during bootstrap. Use isolated test providers for CI and configured real providers for staging acceptance. Put credentials only in the server or worker environment. Configuring Groq selects it for brief extraction, timestamped transcription and cited search answers, with keyword and exact-ID retrieval supplied by PostgreSQL.

The [deployment runbook](../infra/deploy/README.md) defines the static web, API, worker and migration images. API replicas share a Socket.IO Redis adapter and replay authorized events from PostgreSQL. Redis also enforces per-workspace model request limits across API and worker processes. Recovery treats PostgreSQL and private object storage as the durable sources.

## Data paths

1. Browser → authenticated API → domain command → PostgreSQL transaction writes object changes, audit and outbox → response. Dispatcher → BullMQ → idempotent workers → new durable revisions or derived state.
2. Provider → verified ingress → durable receipt → queue → normalize within installation and project mapping → index or propose. Commit a cursor only after its relevant batch succeeds.
3. Browser subscribes to an authorized project room. Buffer live events during replay after reconnect. Deduplicate by durable event ID. Presence expires in Redis and never substitutes for membership.
4. Search applies effective access inside lexical and vector candidate retrieval. Rank fusion groups passages by source. Hydration and synthesized answers recheck current entitlements. A deleted or revoked object vanishes before background cleanup finishes.

## Durable groups

- **Identity** — users, workspaces, memberships, project_members, invitations, source entitlements. Keep roles scoped and record membership changes.
- **Planning** — projects, calendars, work_items (task or milestone), dependency_edges, scenarios, forecasts and risk_findings. Include tenant and project in edge foreign keys. Serialize competing graph edits per project to preserve acyclicity.
- **Knowledge** — documents and versions, meetings, transcript segments, comments, decisions, source objects and revisions, evidence links. Record source, revision, anchor and effective audience.
- **Execution** — agent_runs, proposals, immutable proposal revisions, approvals, executions, audit_events and outbox. Unique execution key per approved revision. Record failures as well as completed effects.
- **Operations** — connector installations, delivery receipts, sync cursors, indexed chunks, notification preferences, delivery attempts and reminders. Scope uniqueness keys to the relevant workspace, destination and revision.

## Access and consistency contracts

Set tenant and principal transaction-locally after session validation. Enforce PostgreSQL row-level security with a non-owner runtime role without BYPASSRLS. Verify project and source access in workers, route handlers, sockets, search, derived reports and attachment delivery. Reject cross-tenant references in database constraints. Keep raw private provider payloads out of client DTOs and logs.

Use version preconditions on writes, opaque cursors on lists, idempotency keys on retriable commands and server-generated correlation IDs on events. Use 202 plus a job resource for async work, 409 plus authorized current values for stale revisions, and a consistent unavailable response for inaccessible objects. An external timeout may mean a successful delivery. Reconcile before retrying.

Representative operations include POST /projects/{id}/briefs, POST /tasks/{id}/comments, POST /projects/{id}/scenarios, POST /proposals/{id}/approve, GET /search and GET /events. Resolve the active tenant from a validated session or authorized route context. Shared commands serve equivalent human and approved agent writes.
