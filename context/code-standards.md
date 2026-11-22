# Implementation standards

## Code organization

Keep browser features under apps/web/src/features by domain, shared UI primitives together, and server modules grouped by capability. Use strict TypeScript. Parse untrusted input with Zod at HTTP, socket, webhook, model and job boundaries. Export request and response types from contracts. Keep database rows, provider payloads and UI view models distinct where their visibility differs.

Use domain functions for schedule arithmetic, state transitions and entitlement decisions. Inject the clock and working calendar into time-sensitive functions. Persist instants in UTC and business dates as dates paired with a project timezone. Resolve “Friday” from the source timestamp and timezone and display an absolute date in review.

## Writes and retries

A command receives an authenticated principal, validated input, expected version and mutation ID where appropriate. Check permissions and versions inside the write boundary. Persist related changes, audit and outbox together. A consumer may run twice. Give it a durable deduplication key and record its effect transactionally. Reuse the existing command when adding an AI entry point.

Model adapters return validated data or a typed failure. Treat workspace text as content, limit context to authorized revisions and verify cited spans. The executor only accepts allowlisted commands bound to a reviewed proposal. Redact text, credentials and model inputs from routine telemetry.

## Client conventions

Scope query keys to tenant, actor/access epoch and resource. Invalidate affected queries on confirmed events. Reconcile optimistic comments using client mutation ID. Keep selection, filters and deep links in the URL when they identify a shareable view. Preserve edits across recoverable errors. Clear private cache on logout, workspace switch or revocation. Announce async results and use labeled native or Radix controls.

## Verification by failure mode

| Risk | Best evidence |
|---|---|
| Incorrect calendar or graph result | Vitest fixtures with weekends, a nonworking date, multiple predecessors, a cycle, missing estimate and independent slack |
| Row policy or transaction regression | Integration tests using the runtime role, real PostgreSQL and Redis, two tenants with identical names and one restricted project |
| Approval replay or stale data | Concurrent commands with one execution receipt; edit or revoke access between approval and application |
| Realtime or UI failure | Playwright in two independent sessions; reconnect, keyboard-only use, narrow viewport, stale source and denied access |
| Provider or model drift | Recorded input/output fixtures plus separately identified live checks with scoped test accounts |

Use ESLint, Prettier, type checks, focused tests and the relevant integration suite. Inspect existing package scripts before running commands. Create scripts during bootstrap and record the actual commands in the tracker. Use additive migrations and verify existing tenant data during changes. Keep generated artifacts and synthetic fixtures free of real workspace data.
