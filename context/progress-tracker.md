# Delivery tracker

**Current state** — Feature 01 is implemented and verified locally. The web, API and worker run against PostgreSQL, Redis and private object storage.

**Next ready feature** — [02 · Interface foundation](feature-specs/02-interface-foundation.md). Use the [session prompt](ai-workflow-rules.md) to start. Numbers indicate suggested delivery order and the prerequisite column lists direct dependencies.

| ID | Feature prompt | Depends on | State | Evidence |
|---|---|---|---|---|
| 01 | [Workspace foundation](feature-specs/01-workspace-foundation.md) | — | Done | Clean-checkout and Redis recovery checks passed. See [Feature 01 evidence](#feature-01-evidence). |
| 02 | [Interface foundation](feature-specs/02-interface-foundation.md) | 01 | Pending | — |
| 03 | [Identity and tenancy](feature-specs/03-identity-and-tenancy.md) | 01, 02 | Pending | — |
| 04 | [Projects and work items](feature-specs/04-projects-and-work.md) | 03 | Pending | — |
| 05 | [Dependencies and forecasts](feature-specs/05-graph-and-forecasts.md) | 04 | Pending | — |
| 06 | [Comments and presence](feature-specs/06-realtime-collaboration.md) | 04 | Pending | — |
| 07 | [Documents and decision register](feature-specs/07-documents-and-decisions.md) | 04, 06 | Pending | — |
| 08 | [Approval engine and audit history](feature-specs/08-approvals-and-audit.md) | 04, 07 | Pending | — |
| 09 | [Brief to approved project plan](feature-specs/09-brief-to-plan.md) | 05, 07, 08 | Pending | — |
| 10 | [Risks from project activity](feature-specs/10-risk-from-activity.md) | 05, 06, 08, 09 | Pending | — |
| 11 | [Meetings and accountable follow-up](feature-specs/11-meetings-and-actions.md) | 06, 07, 08, 09 | Pending | — |
| 12 | [Inbox and deadline delivery](feature-specs/12-inbox-and-deadlines.md) | 06, 08, 10 | Pending | — |
| 13 | [Connector management and ingestion](feature-specs/13-connector-runtime.md) | 03, 04, 07 | Pending | — |
| 14 | [GitHub activity and approved comments](feature-specs/14-github-activity-and-actions.md) | 08, 13 | Pending | — |
| 15 | [Calendar events and shared email](feature-specs/15-calendar-and-gmail.md) | 11, 13 | Pending | — |
| 16 | [Permission-aware hybrid search](feature-specs/16-hybrid-search.md) | 07, 11, 14, 15 | Pending | — |
| 17 | [Weekly health and duplicate review](feature-specs/17-health-and-duplicates.md) | 08, 10, 12, 16 | Pending | — |
| 18 | [Workspace home and activity history](feature-specs/18-workspace-home-and-activity.md) | 10, 11, 12, 14, 17 | Pending | — |
| 19 | [Retention and access lifecycle](feature-specs/19-privacy-and-retention.md) | 13, 15, 16, 17, 18 | Pending | — |
| 20 | [Deployment and recovery](feature-specs/20-operability-and-delivery.md) | 12, 14, 15, 19 | Pending | — |
| 21 | [Accessibility and visual verification](feature-specs/21-accessibility-and-visual-qa.md) | 18, 19 | Pending | — |
| 22 | [Full release evidence](feature-specs/22-release-evidence.md) | 16, 17, 18, 19, 20, 21 | Pending | — |

## Handoff

Use Pending, Active, Blocked or Done. Replace the evidence dash with a commit, test run, measured result or screenshot reference and enough detail to reproduce it. For a blocked item, name the missing dependency and the remaining acceptance check. Keep the next-ready pointer current.

## Feature 01 evidence

Verified on 2026-11-22 using Node 24.22.3 and pnpm 10.34.9 in a clean Git checkout of a temporary project snapshot. Docker used a separate Compose project and unused loopback ports for that run. The default ports were also exercised in the working directory.

| Commands run | Result |
|---|---|
| `cp .env.example .env`, `pnpm install --frozen-lockfile` | Installed all seven workspace projects from the lockfile. |
| `docker compose up -d --wait`, `pnpm db:migrate` twice, `pnpm db:generate` | Three healthy services, pgvector 0.8.7 installed, repeat migration succeeded, and Drizzle reported no schema changes. |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` | All passed. Vitest passed three tests. Vite produced a build with two non-blocking Rollup annotation warnings from Zod. |
| `pnpm exec playwright install chromium`, `pnpm test:e2e` | Browser health loaded, a healthy-path job completed, and an unsigned bucket request returned 403. The test stopped Redis and verified readiness 503, liveness 200 and a pending job. The worker logged the connection error, then completed the same job after Redis restarted. Retrying the request and forcing a second queue delivery left one PostgreSQL receipt with its original completion time. The page fit a 320 px viewport. |
| `pnpm dev`, `curl -fsS http://127.0.0.1:4317/api/health/live`, `curl -fsS http://127.0.0.1:4317/api/health/ready` | The default local stack reported alive and ready. Starting the API and worker without the database and Redis variables failed with the missing field names. |

All local acceptance checks passed. The GitHub Actions workflow is configured and awaits its first hosted run.

**Current product decisions** — The product is named Kordos. The final v1 specification defines scope. The workspace uses an editorial light theme, GitHub is the first approved external write, and all performance numbers are release targets.

**Session note** — Feature 02 is ready to start. The [local development guide](../README.md) documents the bring-up and recovery commands.
