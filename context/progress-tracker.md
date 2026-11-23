# Delivery tracker

**Current state** — Features 01 through 14 are verified locally.

**Next ready feature** — [15 · Calendar events and shared email](feature-specs/15-calendar-and-gmail.md). Numbers indicate suggested delivery order and the prerequisite column lists direct dependencies.

| ID | Feature prompt | Depends on | State | Evidence |
|---|---|---|---|---|
| 01 | [Workspace foundation](feature-specs/01-workspace-foundation.md) | — | Done | Clean-checkout and Redis recovery checks passed. See [Feature 01 evidence](#feature-01-evidence). |
| 02 | [Interface foundation](feature-specs/02-interface-foundation.md) | 01 | Done | Responsive, keyboard, zoom and contrast checks passed. See [Glass refresh evidence](#glass-refresh-evidence). |
| 03 | [Identity and tenancy](feature-specs/03-identity-and-tenancy.md) | 01, 02 | Done | Invitation concurrency, workspace switching, revocation and runtime role isolation passed with the refreshed interface. See [Feature 03 evidence](#feature-03-evidence). |
| 04 | [Projects and work items](feature-specs/04-projects-and-work.md) | 03 | Done | Board edits, private project isolation, archiving and attributed reopening passed. See [Feature 04 evidence](#feature-04-evidence). |
| 05 | [Dependencies and forecasts](feature-specs/05-graph-and-forecasts.md) | 04 | Done | Forecast dates, slack, concurrent cycle rejection and private previews passed. See [Feature 05 evidence](#feature-05-evidence). |
| 06 | [Comments and presence](feature-specs/06-realtime-collaboration.md) | 04 | Done | Reconnect deduplication, private room revocation and presence expiry passed. See [Feature 06 evidence](#feature-06-evidence). |
| 07 | [Documents and decision register](feature-specs/07-documents-and-decisions.md) | 04, 06 | Done | Historical citations, draft recovery, supersession and attachment authorization passed. See [Feature 07 evidence](#feature-07-evidence). |
| 08 | [Approval engine and audit history](feature-specs/08-approvals-and-audit.md) | 04, 07 | Done | Concurrent approval, execution checks and audit tracing passed. See [Feature 08 evidence](#feature-08-evidence). |
| 09 | [Brief to approved project plan](feature-specs/09-brief-to-plan.md) | 05, 07, 08 | Done | Sourced candidates, cycle rejection, atomic approval and timeout recovery passed. See [Feature 09 evidence](#feature-09-evidence). |
| 10 | [Risks from project activity](feature-specs/10-risk-from-activity.md) | 05, 06, 08, 09 | Done | Forecast impact, author clarification, stale replan protection and approved commitment changes passed. See [Feature 10 evidence](#feature-10-evidence). |
| 11 | [Meetings and accountable follow-up](feature-specs/11-meetings-and-actions.md) | 06, 07, 08, 09 | Done | Exact segment playback, reviewed follow-up, reprocessing and media retention passed. See [Feature 11 evidence](#feature-11-evidence). |
| 12 | [Inbox and deadline delivery](feature-specs/12-inbox-and-deadlines.md) | 06, 08, 10 | Done | Quiet-hour rescheduling, read state sync, local email delivery and revocation checks passed. See [Feature 12 evidence](#feature-12-evidence). |
| 13 | [Connector management and ingestion](feature-specs/13-connector-runtime.md) | 03, 04, 07 | Done | Delivery deduplication, checkpoint recovery, private-source isolation and disconnect passed. See [Feature 13 evidence](#feature-13-evidence). |
| 14 | [GitHub activity and approved comments](feature-specs/14-github-activity-and-actions.md) | 08, 13 | Done | Webhook convergence, destination revocation and one reconciled publication passed. See [Feature 14 evidence](#feature-14-evidence). |
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

## Feature 06 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a local OIDC issuer and isolated PostgreSQL and Redis services.

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All eight Vitest tests passed. The build emitted the existing Zod annotation warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed, and Drizzle reported no schema changes. The existing local project was preserved after migration. |
| `pnpm test:e2e --workers=3 --trace=on` and `pnpm test:e2e --project=collaboration --no-deps --trace=on` | All 13 Chromium tests passed in the full suite. The focused rerun confirmed the task discussion reflows at 1440, 1024, 390 and 320 CSS px. |
| Reconnect and editing | The [Feature 06 browser test](../tests/e2e/realtime-collaboration.spec.ts) held HTTP replay open while the same event arrived live. The two sessions each showed one comment. The recipient received one announcement and retained keyboard focus. Resubmitting the mutation ID returned the original comment with one audit and outbox pair. Project and task discussions stayed distinct. Mentions, replies, edits, stale versions, resolution and reopening passed. |
| Access and presence | A workspace admin outside the private project and a lead guessing a nonexistent task could not join. Removing the contributor revoked the open room, denied replay and suppressed the next live event. Runtime SQL returned no comments to either denied actor. Stopping Redis heartbeat renewal removed presence while the saved comment remained visible. |

Viewers can read discussions, contributors can post, and thread authors and project leads can resolve or reopen threads. Archived discussions are read-only. The API wakes Socket.IO delivery on PostgreSQL change notifications and replays from the durable outbox. Presence expires after 15 seconds without a heartbeat. The shared subject contract is ready for documents and meetings, and Feature 12 covers inbox delivery for mentions.

All local Feature 06 acceptance checks passed.

## Feature 07 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a local OIDC issuer and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All eight Vitest tests passed. The build emitted the existing Zod annotation warnings. |
| `pnpm db:migrate` and `pnpm db:generate` | Fresh and repeated migrations passed. An isolated Feature 06 database retained its restricted project and existing comment under the runtime role. The local Compose database migrated with its project and comment counts intact. Drizzle reported no schema changes. |
| `pnpm test:e2e --workers=3 --trace=on` and `pnpm test:e2e --project=knowledge --no-deps --trace=on` | All 14 Chromium tests passed. The focused [Feature 07 journey](../tests/e2e/documents-and-decisions.spec.ts) also checked document reflow at 1440, 1024, 390 and 320 CSS px. |
| Document editing and citations | Formatting rendered safely, including literal HTML. A passage selected after an emoji resolved to the exact original quote after three later revisions. The anchored comment continued to link to revision 1. A stale save returned 409, preserved the draft and supported a merge. Restoring revision 1 created revision 4 with the current base and restore attribution. Archived documents remained readable at their stable links. |
| Decision history and access | A contributor drafted a decision and a lead confirmed it. A superseding decision retained both links, the original conclusion and its effective period. A viewer received no private source IDs or excerpts. Removing source project membership hid both a document passage and a comment from an open decision, denied the old citation URL, and suppressed document rows under the runtime role. |
| Attachment authorization and retries | Allowed downloads returned the original bytes as an attachment with no-store caching. Unsigned object storage access, an unauthorized viewer and a revoked member were denied. Two simultaneous uploads with the same mutation ID returned one attachment. Reusing that mutation ID with different bytes returned 409. |

Document formatting supports headings, lists, emphasis, inline code and task links. Archived documents are read-only. Attachments are limited to 10 MB. The shared citation resolver supports document spans and comment IDs, and it checks each source project's current access before including it in a decision.

All local Feature 07 acceptance checks passed. Feature 08 is ready.

## Feature 08 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a local OIDC issuer and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeated migrations passed. An upgrade from Feature 07 preserved a restricted project, its work item and the original audit attribution under the runtime role. Drizzle found no schema changes. |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All eight Vitest tests passed. The build emitted the existing Rollup annotation warnings from Zod. |
| `pnpm test:e2e --workers=3 --trace=on` | All 15 Chromium tests passed. The [Feature 08 journey](../tests/e2e/approvals-and-audit.spec.ts) covered draft and review, receipts, audit links and reflow at 1440, 1024, 390 and 320 CSS px. Chromium trace frames showed readable pending and stale reviews on mobile and the audit trail on desktop. |
| Concurrent approvals and retries | Two independent project leads returned the same receipt. Retrying approval and redelivering the queue job left one work edit and one applied effect. Editing an approved revision invalidated its receipt and required the new draft to be submitted and approved. |
| Changes before execution | The worker recovered a claimed receipt and halted it when the target changed. Loss of source access and removal followed by restoration of the reviewer's project membership each prevented application. The stale review let a lead carry proposed edits onto current work. An expired approval and a newly ineligible owner each produced a terminal receipt without changing the work item. |
| Audit and reconciliation | Audit history linked a manual edit, a rejection and an applied revision to their actors and effects. The runtime role could neither update audit events and revisions nor read private source history without access. A database fixture with an unexpected prior execution event entered reconciliation and left the work item unchanged. |

Work-item proposals expire after seven days by default. Approval binds the exact revision and current requester and reviewer authority. Reviewers can follow the receipt to the applied work edit, and proposal values and evidence are resolved against the viewer's current access.

All local Feature 08 acceptance checks passed. Feature 09 is ready.


## Feature 09 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and text-model fixtures, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including ten Vitest tests. The build reported two Zod annotation warnings and a 501 kB entry chunk above Vite's warning threshold. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed, and Drizzle found no schema changes. An isolated Feature 08 database preserved a restricted project, original proposal revision and source document. The pre-upgrade approval applied through its existing receipt under the runtime role. |
| `pnpm test:e2e --workers=3 --trace=on` and `pnpm test:e2e --project=briefs --no-deps --trace=on` | All 16 browser tests passed, including Redis recovery and Features 02–08. The focused [Feature 09 journey](../tests/e2e/brief-to-plan.spec.ts) passed again after the final UI loading change. It checked reflow at 1440, 1024, 390 and 320 CSS px. Trace frames showed the candidate editor, source excerpts, review actions and timeout recovery. |
| Candidate review and provenance | A four-task brief yielded three dependency branches. The unnamed reviewer stayed unassigned, and the deadline resolved against the source timestamp and project timezone. A citation after an emoji resolved to the exact source text. The browser renamed, split, added and removed tasks, rejected a cycle with no work created, then approved the corrected revision. The resulting five tasks and four edges had one receipt and one batch effect. An applied task linked back to its brief, proposal revision and supporting passage. |
| Access and retry behavior | An outsider received 404 for the brief, proposal and task provenance. The API database role could not read the brief table or claim extraction jobs. Concurrent retries and repeated queue delivery preserved one result and one approval effect. Selecting the same historical document revision reused its brief. Three provider timeouts preserved the text and enabled manual drafting without creating work. |

A brief can use pasted text or an existing project document revision. Extraction uses the source revision's timestamp and the project timezone recorded at intake. Each source revision supports one brief job and up to one plan proposal. Extraction supports three attempts and a manual draft from the saved source.

All local Feature 09 acceptance checks passed. Live OpenAI verification remains a staging check and requires the [worker configuration](../README.md#brief-extraction). Feature 10 is next.


## Feature 10 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and model fixtures, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including 14 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. An isolated upgrade from Feature 09 preserved a source brief and backfilled the latest revision of a pre-existing project comment. Replay left one finding under the runtime role. |
| `pnpm test:e2e --workers=3 --trace=on` and `pnpm test:e2e --project=risks --no-deps --trace=on` | All 17 Chromium tests passed. The focused [Feature 10 journey](../tests/e2e/project-activity-risks.spec.ts) passed after the final UI edits. Reflow passed at 1440, 1024, 390 and 320 CSS px. Desktop and mobile trace frames showed the evidence, comparison, affected path and review actions. |
| Forecast and acknowledgement | A Friday API handoff identified QA and Wednesday launch. Monday remained the commitment during review and changed to Wednesday after approval. The lead's acknowledgement note and the service-attributed severity event appeared in the history. An unrelated copy delay produced no active milestone risk, and a parallel branch within its slack left the milestone forecast unchanged in Vitest. |
| Clarification, supersession and permissions | Two identical Auth titles prompted for clarification. Only the comment author could select a task. Editing the report preserved the earlier quote and finding, removed the outdated proposal from the pending queue and rejected approval with 409. A second edit after approval stopped queued execution and preserved the Monday commitment. A graph input change required a refreshed finding before a new proposal. An outsider received 404, and the runtime role could neither read the risk table directly nor bypass the guarded approval executor. |

Risk extraction uses explicit delay language, task context and supported absolute or relative date phrases. Dates resolve in the project timezone from the comment revision's timestamp. A replan proposes a specific milestone commitment through the existing approval engine.

All local Feature 10 acceptance checks passed. Feature 11 is next.


## Feature 11 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and transcription fixtures, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including 17 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed, and Drizzle found no schema changes. An isolated upgrade from Feature 10 preserved a restricted project, its source document and pending approval. The original approval applied through the same receipt after upgrading. |
| `pnpm test:e2e --workers=3 --trace=on` and `pnpm test:e2e --project=meetings --no-deps --trace=on` | All 18 browser tests passed. The focused [Feature 11 journey](../tests/e2e/meetings-and-actions.spec.ts) also verified immediate playback revocation and automatic expiry. Reflow passed at 1440, 1024, 390 and 320 CSS px. Desktop and mobile trace frames showed the capture controls, transcript and follow-up. |
| Authorization, playback and follow-up | The WAV upload required authorization and recovered from a simulated timeout. Approval produced one task and receipt across repeated approval and duplicate worker delivery. The task linked to the exact 00:03–00:05 clip and its supporting quote. Completing the task updated its meeting. The approved decision appeared in the register with a meeting citation. |
| Correction, reprocessing and retention | “Ask Maya about rollout” stayed unassigned until the reviewer chose an owner. Correcting a speaker created a new transcript revision, made the affected proposal stale, and preserved accepted items on reprocessing. A separate pasted transcript produced a question without a provider call. Project membership revocation denied meeting, audio, citation and decision access. Explicit removal and expiry blocked playback and deleted the private object. The transcript and approved decision remained readable to authorized project members. |

Private recordings accept MP3, WAV and M4A up to 20 MB. Meetings support 7-, 30- and 90-day recording retention. Follow-up extraction uses explicit transcript cues and resolves dates against the meeting time and project timezone. Live OpenAI transcription remains a staging check and requires the [worker configuration](../README.md#meeting-recordings).

All local Feature 11 acceptance checks passed. Feature 12 is next.

## Feature 12 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a loopback OIDC issuer and email sink, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including 17 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. An upgrade from Feature 11 preserved an existing task and pending review and delivered each eligible alert once under the app runtime role. The local Compose database retained its project, work item, comment and document counts after migrating. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-12-full` | All 19 Chromium tests passed, including Redis recovery and Features 02–11. The [Feature 12 journey](../tests/e2e/inbox-and-deadlines.spec.ts) verified inbox reflow at 1440, 1024, 390 and 320 CSS px. Desktop and mobile trace frames showed the filters, deadline and read control. |
| `pnpm test:e2e --project=inbox --no-deps --trace=on --output=test-results/feature-12-final` | Passed after adding browser assertions for due work, pending reviews and open risks on Home and a successful immediate assignment email that opened the recipient’s notification. |
| Deadlines and read state | Editing a deadline during quiet hours canceled the old job and delivered exactly one reminder for the new date. Completion and archival suppressed pending jobs. An overdue owner and the accountable lead each received their own alert. Non-deadline edits preserved the due-date revision. Database fixtures checked project and recipient times across daylight-saving transitions. Two browser sessions showed the same saved read state. |
| Email, review and risk access | A failed email preserved the in-app reminder. Two mentions produced one digest with authorized links. Revocation canceled a deferred mention, suppressed an email retry and denied the old inbox, digest contents and risk link. A resolved risk remained traceable through its original evidence for project members. A rejected review appeared as resolved and left the pending count. The app role was denied direct queue and email-dispatch access. |

Deadlines use the project timezone and the explicit deadline, with the milestone commitment as fallback. Reminders default to 09:00 one calendar day before the deadline. Escalation defaults to two calendar days after the deadline becomes overdue. Members can set lead times, quiet hours, delivery timezone and a channel for each notification type. The daily digest runs at 08:00 recipient time and links to the authorized entries for its delivery day. See [inbox configuration](../README.md#inbox-delivery) for the local sink and email settings.

All local Feature 12 acceptance checks passed. Live email provider verification remains a staging check. Feature 13 is ready.

## Feature 13 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a loopback OIDC issuer and connector adapter, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including 17 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. Upgrading the local Feature 12 database preserved the project, work item, document and inbox counts. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-13-full` | All 20 Chromium tests passed. The [Feature 13 journey](../tests/e2e/connectors.spec.ts) added a second scope, paused and resumed syncing, and removed the mapping without affecting its neighbor. Settings reflow passed at 1440, 1024, 390 and 320 CSS px. Desktop and mobile trace frames showed redacted private health. |
| Delivery and recovery | A signed delivery replay returned the same receipt and one revision. An invalid signature was rejected, a conflicting replay returned 409, and an older revision left the current snapshot in place. A failed second page preserved the previous checkpoint and published none of the staged changes. An expired checkpoint triggered full reconciliation and recovered the same source ID. |
| Credential and audience boundaries | The persisted grant was encrypted. A revoked token paused its installation and left a neighboring connection healthy. Replacing the token restored the existing mapping. A workspace admin outside the private project could diagnose health without mirrored text, private project metadata or provider scope. Direct runtime access to credentials, mirrored text and worker job claims was denied. |
| Disconnect and shares | Disconnect made an open mirror unavailable and canceled queued outbound intent while mirror text still awaited cleanup. Deferred cleanup removed the original body. An approved excerpt stayed visible to project members until its sharer revoked it. |

Connection owners can map scopes to projects where they are leads. Admins can see and manage connection health across the workspace. A private provider grant restricts a mirror to the owner with project access. The worker reconciles active scopes every five minutes and mirror verification expires after ten minutes. Disconnect queues cleanup for five minutes later. The [connector setup](../README.md#connector-runtime) documents the fixture protocol. Live GitHub and Google adapters are covered by Features 14 and 15.

All local Feature 13 acceptance checks passed. Feature 14 is ready.


## Feature 14 evidence

Verified on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, a loopback OIDC issuer and GitHub API fixture, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All 17 Vitest tests passed. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. An isolated Feature 13 upgrade preserved a private project, fixture installation and mirror revision under the runtime role. The additive migration was also applied to the local Compose database. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-14-full` | All 21 tests passed, including Redis recovery and Features 02–13. The [GitHub journey](../tests/e2e/github-activity-and-actions.spec.ts) checked activity reflow at 1440, 1024, 390 and 320 CSS px. Desktop and mobile trace frames showed the activity rows and exact comment review. |
| `pnpm test:e2e --project=github --project=reviews --no-deps --workers=1 --trace=on --output=test-results/feature-14-final` | Both tests passed after adding the active work-link requirement and GitHub comment URL lookup. The browser opened the approved revision from the remote URL, and the ordinary work-item approval still passed. |
| Webhooks, repair and links | A signed replay reused its receipt. An invalid signature received 401 and conflicting reuse received 409. An open event delivered after a close left the canonical PR merged, with one added revision at the same provider timestamp. Sync repaired a missed title and head commit update. Explicit IDs and confirmed matches linked work in the mapped project. A neighboring tenant could not claim the installation, and a project viewer could not read the private repository mirror. |
| Approval and remote receipt | Concurrent approvals shared one execution. Adding repository B to the approval request still published only to A. Removing B's GitHub grant before publication recorded a refusal. Restoring access and approving a new revision published one issue comment to B. A timeout after GitHub accepted A's comment produced one provider comment and one receipt linked to its exact reviewed Markdown, approver and audit event. |

GitHub installations are bound to a workspace in server configuration. Comments require an issue or pull request linked to active work in its mapped project. The exact reviewed Markdown includes a delivery reference that lets the worker reconcile without issuing another POST. The [GitHub App setup](../README.md#github-app) documents configuration and scan limits.

All local Feature 14 acceptance checks passed. Live GitHub App verification remains a staging check using a designated installation. Feature 15 is ready.
