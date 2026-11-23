# Delivery tracker

**Current state** — Features 01 through 05 are verified locally.

**Next ready feature** — [06 · Comments and presence](feature-specs/06-realtime-collaboration.md). Numbers indicate suggested delivery order and the prerequisite column lists direct dependencies.

| ID | Feature prompt | Depends on | State | Evidence |
|---|---|---|---|---|
| 01 | [Workspace foundation](feature-specs/01-workspace-foundation.md) | — | Done | Clean-checkout and Redis recovery checks passed. See [Feature 01 evidence](#feature-01-evidence). |
| 02 | [Interface foundation](feature-specs/02-interface-foundation.md) | 01 | Done | Responsive, keyboard, zoom and contrast checks passed. See [Glass refresh evidence](#glass-refresh-evidence). |
| 03 | [Identity and tenancy](feature-specs/03-identity-and-tenancy.md) | 01, 02 | Done | Invitation concurrency, workspace switching, revocation and runtime role isolation passed with the refreshed interface. See [Feature 03 evidence](#feature-03-evidence). |
| 04 | [Projects and work items](feature-specs/04-projects-and-work.md) | 03 | Done | Board edits, private project isolation, archiving and attributed reopening passed. See [Feature 04 evidence](#feature-04-evidence). |
| 05 | [Dependencies and forecasts](feature-specs/05-graph-and-forecasts.md) | 04 | Done | Forecast dates, slack, concurrent cycle rejection and private previews passed. See [Feature 05 evidence](#feature-05-evidence). |
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

**Current product decisions** — The product is named Kordos. The final v1 specification defines scope. The workspace uses a soft gradient canvas, frosted navigation and restrained glass artwork. GitHub is the first approved external write. All performance numbers are release targets.

## Feature 02 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9 and Playwright Chromium. The browser suite used an isolated Compose project with a freshly migrated database.

| Commands run | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` | All passed. Vitest passed three tests. The production build excluded the preview entry and fixture content. Rollup emitted the existing Zod annotation warnings. |
| `pnpm test:e2e --workers=3` | Nine tests passed. Chromium verified the title, primary action and active destination at 1440, 1024, 390 and 320 CSS px. It also verified 200% page zoom, no horizontal overflow, keyboard navigation, focus restoration, reduced motion, evidence deep links, and the signed-out route boundary. The Feature 01 Redis recovery check passed. |

| Overview | Desktop at 1440 px | Mobile at 390 px |
|---|---|---|
| Populated | [Screenshot](evidence/feature-02/populated-desktop.png) | [Screenshot](evidence/feature-02/populated-mobile.png) |
| Empty | [Screenshot](evidence/feature-02/empty-desktop.png) | [Screenshot](evidence/feature-02/empty-mobile.png) |

Feature 03 adds live sign-in and tenancy. Feature 04 supplies real projects and task creation. Brief intake is covered by Feature 09.

## Pixel refresh evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9 and Chromium. The refresh applies to the project overview, shared workspace navigation, sign-in and shared controls. The [glass refresh](#glass-refresh-evidence) superseded this design.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` | Passed, including all three unit tests. The production build excludes the preview and its fixture data. Rollup reported the existing Zod annotation warnings. |
| `pnpm db:migrate`, `pnpm test:e2e --workers=3` | Nine tests passed against an isolated Compose project. Chromium checked 1440, 1024, 390 and 320 CSS px, 200% zoom, keyboard focus, reduced motion, evidence links, signed-out routing and Redis recovery. |
| Manual screenshot review and token contrast calculation | Reviewed both overview states, the navigation drawer, sign-in and workspace health. Checked text and status pairs measured 6.15:1 or higher. Checked control outlines measured 3.31:1 or higher. |

| Overview | Desktop at 1440 px | Mobile at 390 px |
|---|---|---|
| Populated | [Screenshot](evidence/feature-02/pixel-refresh/populated-desktop.png) | [Screenshot](evidence/feature-02/pixel-refresh/populated-mobile.png) |
| Empty | [Screenshot](evidence/feature-02/pixel-refresh/empty-desktop.png) | [Screenshot](evidence/feature-02/pixel-refresh/empty-mobile.png) |

The Feature 02 refresh has no outstanding acceptance checks.

## Feature 03 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium and an isolated Compose project. The [identity scenario](../tests/e2e/identity-tenancy.spec.ts) signs into the application using a local OIDC issuer that signs ID tokens and checks PKCE.

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` | Passed. Three Vitest tests passed. The build reported the existing Rollup warnings from Zod. |
| `pnpm db:migrate` twice, `pnpm db:generate` | Migration applied on a fresh database and on the existing foundation database. The repeat run succeeded and Drizzle found no schema changes. |
| `pnpm test:e2e --workers=3` | Ten Chromium tests passed, including Redis recovery and the Feature 02 regressions. Membership settings fit 1440, 1024, 390 and 320 CSS px without horizontal overflow. |
| Invitation redemption | An expired link and a mismatched recipient received 404. Three concurrent requests from the intended recipient produced one success and one membership. The browser also resumed a pending invitation after OIDC sign-in and accepted it. |
| Switching and revocation | Alice switched between identically named projects with different contents. Stale role updates received 409 and the current role and version. The last administrator could neither demote nor remove themselves. Removing Alice revoked tenant access immediately at the API, cleared the open view on its next refresh, and preserved her audit attribution. |
| PostgreSQL runtime isolation | A one-connection pool reused the same PostgreSQL backend for Alice, Bo and an unauthenticated scope after both commit and rollback. The non-owner runtime role had no BYPASSRLS privilege, returned only authorized rows, denied cross-tenant changes, and could not modify audit history. |

Administrators share the generated invitation link with the verified recipient. The app rechecks membership on each tenant request and refreshes active browser access every five seconds. Sign-in against a live Auth0 tenant remains a staging check and requires the [Auth0 configuration](../README.md#auth0-sign-in). Feature 04 can proceed.

## Glass refresh evidence

Verified on 2026-11-23. The refresh covers the workspace shell and project views, sign-in, workspace selection and membership settings. The new [UI and UX guidance](ui-context.md) applies to future features.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` | Passed, including three unit tests. The production build excludes the Vite preview. The existing Zod annotation warnings remain. |
| `pnpm db:migrate`, `pnpm test:e2e --workers=3` | Migrated the isolated Compose database. All ten Chromium tests passed, including 320 px reflow, 200% zoom, keyboard focus, Redis recovery and Feature 03 identity and tenant isolation. |
| Visual and contrast checks | Reviewed populated and empty projects on desktop and mobile, plus sign-in, settings and the workspace picker with a local OIDC fixture. Checked text pairs measured at least 4.87:1 and the checked control outline measured 3.23:1. Chromium used an opaque surface with blur disabled in reduced-transparency mode. |

| Overview | Desktop at 1440 px | Mobile at 390 px |
|---|---|---|
| Populated | [Screenshot](evidence/feature-02/glass-refresh/populated-desktop.png) | [Screenshot](evidence/feature-02/glass-refresh/populated-mobile.png) |
| Empty | [Screenshot](evidence/feature-02/glass-refresh/empty-desktop.png) | [Screenshot](evidence/feature-02/glass-refresh/empty-mobile.png) |

The refresh has no outstanding local acceptance checks. Live Auth0 verification remains a staging check.

## Feature 04 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a local OIDC issuer and an isolated Docker Compose stack.

| Check | Result |
|---|---|
| `pnpm db:migrate` twice and `pnpm db:generate` | A fresh database migrated successfully. A separate database seeded at Feature 03 retained both legacy project records, inherited the workspace timezone and preserved their visibility under the runtime role. The repeat migration succeeded and Drizzle reported no schema changes. |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including three Vitest tests. The production build emitted the existing Rollup warnings from Zod. |
| `pnpm test:e2e --workers=3 --trace=on` | All 11 Chromium tests passed, including Redis recovery, interface and identity regressions, and the [Feature 04 browser journey](../tests/e2e/projects-and-work.spec.ts). |
| Board, list and task detail | Two independent browser sessions saved against the same task version. One save succeeded and one returned 409 with the latest version. The second editor retained its draft and merged the other edit on retry. The saved result appeared in the filtered list after refresh and at the stable task URL. Keyboard dismissal restored focus to the card, and the inspector fit 1440, 1024, 390 and 320 CSS px. |
| Audience and permissions | New projects defaulted to restricted. A same-workspace admin outside the project received 404 over HTTP and saw no project metadata, task titles or audit data through runtime SQL. A lead previewed the workspace audience and made the project visible. Restricting it again and removing an explicit member each cleared an open task view on refresh. Only a lead could set the milestone commitment, and a concurrent retry saved one milestone and one audit and outbox event. |
| Work lifecycle and attribution | Completing then reopening a task recorded the actor and the transition from Done to Ready. Archiving removed work from the active project count and assigned work, while its stable detail URL and audit history remained available. Project archive filtering and reopening passed. |

Workspace visibility grants read access to current and future workspace members. Editing and assignment require an eligible explicit project role. The overview uses the earliest committed date among open milestones. Feature 04 has passed all local acceptance checks. Feature 05 is next, and Feature 06 also has its prerequisites met.

## Feature 05 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a local OIDC issuer and an isolated Docker Compose stack.

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. Vitest passed eight tests, including five forecast tests. The build emitted the existing Zod annotation warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. An upgrade from Feature 04 preserved project visibility, calendar settings, and work revisions under the runtime role. PostgreSQL rejected a cross-project edge through its composite foreign key. Drizzle reported no schema changes. |
| `pnpm test:e2e --workers=3 --trace=on` | All 12 Chromium tests passed. The [Feature 05 browser test](../tests/e2e/dependencies-and-forecasts.spec.ts) checked the canvas, keyboard-operated list, affected owners, and reflow at 1440, 1024, 390 and 320 CSS px. |
| Calendar, slack and uncertainty | Against a Monday commitment, Friday handoff plus two full QA days forecast Wednesday morning. Thursday handoff forecast Tuesday morning. A slip inside the parallel branch's slack kept the milestone forecast in place. Missing effort made the downstream path uncertain. Fixtures covered an actual completion across a timezone boundary and an explicit holiday. |
| Concurrency and private previews | Two opposite edge requests produced one edge and one cycle response with its path. A retry returned the original result with one audit and outbox event. Scenario retries returned the same preview, stale inputs returned 409, and a project collaborator could neither fetch nor discard another member's scenario. Closing and resetting a preview preserved the saved graph and commitment. Project revocation cleared the graph on refresh. |

Open work uses remaining workday estimates. Missing estimates reserve one provisional workday and flag downstream dates as uncertain. Slack uses the earlier of the milestone forecast and commitment. Closing a scenario returns to the baseline and keeps the private preview available at its URL. Resetting deletes the preview. The approval workflow can use the versioned scenario payload in a later feature.

All local Feature 05 acceptance checks passed. Feature 06 is ready.
