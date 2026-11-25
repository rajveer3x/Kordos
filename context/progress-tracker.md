# Delivery tracker

**Current state** — Features 01 through 21 are verified locally. Feature 22 search and audit fixes passed the local release gates. Connected staging verification remains open.

**Next ready feature** — No later feature is listed. Resume [22 · Full release evidence](feature-specs/22-release-evidence.md) when the designated staging environment and provider test accounts are available. Numbers indicate suggested delivery order and the prerequisite column lists direct dependencies.

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
| 15 | [Calendar events and shared email](feature-specs/15-calendar-and-gmail.md) | 11, 13 | Done | Calendar cancellation, per-message excerpt sharing and recovery from both expired cursors passed. See [Feature 15 evidence](#feature-15-evidence). |
| 16 | [Permission-aware hybrid search](feature-specs/16-hybrid-search.md) | 07, 11, 14, 15 | Done | Semantic retrieval, exact IDs during an outage, cited disagreement and immediate revocation passed. See [Feature 16 evidence](#feature-16-evidence). |
| 17 | [Weekly health and duplicate review](feature-specs/17-health-and-duplicates.md) | 08, 10, 12, 16 | Done | Commitment slack, historical evidence revocation, versioned dismissal and cycle-safe consolidation passed. See [Feature 17 evidence](#feature-17-evidence). |
| 18 | [Workspace home and activity history](feature-specs/18-workspace-home-and-activity.md) | 10, 11, 12, 14, 17 | Done | Scoped priorities, matching review and audit identifiers, and mobile activity return passed. See [Feature 18 evidence](#feature-18-evidence). |
| 19 | [Retention and access lifecycle](feature-specs/19-privacy-and-retention.md) | 13, 15, 16, 17, 18 | Done | Open evidence revocation, interrupted deletion recovery and redacted audit attribution passed. See [Feature 19 evidence](#feature-19-evidence). |
| 20 | [Deployment and recovery](feature-specs/20-operability-and-delivery.md) | 12, 14, 15, 19 | Done | The local restore, worker crash and model outage checks passed. See [Feature 20 evidence](#feature-20-evidence). |
| 21 | [Accessibility and visual verification](feature-specs/21-accessibility-and-visual-qa.md) | 18, 19 | Done | Keyboard edit and recovery, four viewport widths and 200% zoom passed. See [Feature 21 evidence](#feature-21-evidence). |
| 22 | [Full release evidence](feature-specs/22-release-evidence.md) | 16, 17, 18, 19, 20, 21 | Blocked | Local search and audit gates passed. Live provider and staging checks remain open. See [remediation evidence](#feature-22-remediation) and the [release issues](current-issues.md#feature-22-release-verification). |

**Groq provider update** — Done for Features 09, 11 and 16. Synthetic requests passed against live Groq. See [verification](#groq-provider-verification).

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

The [hosted CI passage-selection issue](current-issues.md#hosted-ci-document-passage-selection) reproduced twice on Ubuntu Chromium. The updated browser test passed three times each in Ubuntu and macOS Chromium. Hosted verification of the fix is pending.

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

## Feature 15 evidence

Verified locally on 2026-11-23 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and Google API fixtures, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. An isolated Feature 14 upgrade preserved an existing restricted project, meeting and fixture mirror under the app runtime role. |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All 17 Vitest tests passed. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-15-full` | All 22 Chromium tests passed, including Redis recovery and Features 02–14. |
| `pnpm test:e2e --project=google --no-deps --workers=1 --trace=on --output=test-results/feature-15-final` | The focused [Google connector journey](../tests/e2e/calendar-and-gmail.spec.ts) passed after the final focus handling edit. It checked focus after OAuth and reflow at 1440, 1024, 390 and 320 CSS px. Trace frames showed the mobile scope picker, shared excerpt and canceled meeting. |
| Calendar and access | Selecting and attaching an event created one project meeting across repeated attachment. A failed second page preserved the previous token and meeting title. The next successful sync applied the new title and time. A cancellation with only an event ID preserved the meeting, confirmed decision and supporting transcript excerpt. A signed-in Calendar attendee outside the workspace received 404. |
| Gmail and access | A project viewer could read the approved excerpt and share attribution. The original subject, remaining body and later message in the same thread stayed private. Sync checked only the selected label for message contents. Revocation made the shared excerpt unavailable. The app runtime role was denied direct access to Gmail text and encrypted credentials. |
| Cursor recovery and OAuth | Calendar 410 and Gmail history 404 triggered paginated rescans of the selected scopes. Rebuild preserved the meeting, message and share IDs without exposing any additional content. The OAuth fixture verified PKCE, offline authorization, callback replay denial and rejection of a reconnect from a different Google account. |

Each connection maps one selected calendar or Gmail label. Calendar previews use event titles and start times. An explicit attachment lets Calendar changes update the shared meeting. Gmail shares capture a selected excerpt of one message revision and support independent revocation.

All local Feature 15 acceptance checks passed. Feature 16 is ready. Live Google verification remains a staging check using designated test accounts and a configured OAuth client. See the [Google connector setup](../README.md#google-calendar-and-gmail).

## Feature 16 evidence

Verified locally on 2026-11-24 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and search model fixtures, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All 17 Vitest tests passed. The build reported the existing Zod annotation warnings and a 541 kB entry chunk above Vite's warning threshold. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. A populated Feature 15 upgrade backfilled a restricted document, preserved both revisions after an edit, and produced one rebuild across concurrent workers. The previous text disappeared while the update was queued, and an ungranted viewer saw neither pending status nor the owner. The local development migration was aligned without changing canonical row counts. |
| `pnpm test:e2e --project=search --no-deps --workers=1 --trace=on --output=test-results/feature-16-focused` | The focused [search journey](../tests/e2e/hybrid-search.spec.ts) passed. It checked the shareable filters, a speaker-attributed transcript result, an exact document passage with an emoji, empty search, error recovery and reflow at 1440, 1024, 390 and 320 CSS px. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-16-full` | All 23 Chromium tests passed, including Redis recovery and Features 02–16. The isolated run set `POSTGRES_DB` to the same database used by the app and worker. |
| Hybrid ranking and exact IDs | A paraphrase with no keyword match retrieved the labeled decision. Exact PR IDs, repository-qualified IDs and GitHub URLs worked during a simulated embedding outage without making query embedding requests. Keyword search remained available. |
| Access and cited answers | A neighboring tenant and an ungranted viewer received no private results. Original Gmail text and an owner-only PR stayed out of model inputs. Revocation hid a restricted document with its index rows still present and suppressed a Gmail excerpt revoked during answer generation. A conflict showed both dated, attributed decisions, and insufficient evidence returned available passages. The API database role could neither select raw index text nor claim embedding jobs. |

Keyword and exact-ID search use the local index. Semantic ranking and cited passage selection use separately configured model settings. Live model verification remains a staging check. The release-scale workload remains part of Feature 22. See [workspace search setup](../README.md#workspace-search).

All local Feature 16 acceptance checks passed. Feature 17 is ready.


## Feature 17 evidence

Verified locally on 2026-11-24 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including 17 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. A populated Feature 16 upgrade preserved a restricted project, its work and its pending proposal. The existing approval applied through the worker after the upgrade. The local Compose migration preserved the project, work, proposal and document counts. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-17-full` | All 23 existing browser tests passed. The new journey reached consolidation and stopped at an invalid discussion fixture. |
| `pnpm test:e2e --project=project-health --no-deps --trace=on --output=test-results/feature-17-final` | The [Feature 17 journey](../tests/e2e/health-and-duplicates.spec.ts) passed with the corrected fixture and final UI. It checked report reflow at 1440, 1024, 390 and 320 CSS px and duplicate review at 320 px. Reviewed desktop and mobile report screenshots and the mobile duplicate comparison. |
| Weekly health and evidence | A late handoff left its milestone on track with six working days of commitment slack. A missing predecessor estimate produced a provisional forecast with unknown slack. The report linked work and completion events, and the cited review opened its permitted evidence. Revoking restricted source access removed the affected decision request from a saved historical report while an authorized lead could still read it. The app role was denied raw snapshots and report job claims. |
| Duplicate review and consolidation | Dismissal persisted in both directions for the same revisions. A task edit made the pair eligible again. The related link appeared from the other task. Concurrent approvals returned one receipt, and repeated worker application produced no second effect. Consolidation preserved the archived task, its discussion and audit history, plus original and redirected dependencies. A graph edit after approval made a queued consolidation stale, and a fresh proposal for the cyclic pair returned 409. |

Reports use Monday-start weeks in each project’s time zone and retain the last successful capture for each week. Duplicate suggestions use local lexical retrieval for open tasks in the same project. See [weekly health and duplicate review](../README.md#weekly-health-and-duplicate-review).

All Feature 17 acceptance checks passed locally. Feature 18 is ready.


## Feature 18 evidence

Verified locally on 2026-11-24 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including all 17 Vitest tests. The build reported the existing Zod annotation warnings and a 545 kB entry chunk above Vite's warning threshold. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. An isolated Feature 17 upgrade preserved a restricted project, one pending review, a weekly report and the original audit event ID under the app role. The local Compose migration preserved project, work, proposal, audit and weekly report counts. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-18-full` | All 25 Chromium tests passed. The [Feature 18 journey](../tests/e2e/workspace-activity.spec.ts) checked project activity at 1440, 1024, 390 and 320 CSS px. Desktop and mobile screenshots showed the selected event and its task and receipt links. |
| Home and authorization | A lead saw an actionable proposal in Home and project overview. A viewer could read submitted public activity and the confirmed decision. Draft activity and restricted-project activity respected access. Revocation removed a restricted project's history, archival cleared active priorities while preserving permitted history, and switching workspaces cleared the previous workspace's priorities. |
| Action and navigation | Approval removed the pending Home row and updated the linked due task. The project audit, task history and approval receipt shared the same effect event and receipt IDs. Actor, source and type filters returned consistent cursor pages. Mobile Back from the task and review restored the same URL, cursor and selected event. |

Home gives unconfirmed decisions priority for project leads and shows unsuperseded decisions confirmed in the past seven days. Project activity identifies Workspace and GitHub audit events and retains its filters and selection in the URL.

All Feature 18 acceptance checks passed locally. Feature 19 is ready.

## Feature 19 evidence

Verified locally on 2026-11-24 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and transcription fixtures, and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including 17 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk size warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeat migrations passed. Drizzle found no schema changes. A populated Feature 18 upgrade preserved a restricted project, task, transcript and workspace creation audit entry under the runtime role. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-19-full` | All 26 Chromium tests passed, including Redis recovery and Features 02–19. |
| `pnpm test:e2e --project=retention --no-deps --trace=on --output=test-results/feature-19-final` | Passed with the final reflow assertions. Reviewed desktop and mobile screenshots of the policy form and deletion progress. |
| Open evidence and revoked shares | The [retention journey](../tests/e2e/retention-and-access.spec.ts) expired the same recording and transcript while search, weekly health and the meeting were open. A subsequent request to the copied audio URL and the old transcript URL returned 404. The open views removed the expired evidence, and explicitly revoking an email excerpt removed it from search and its direct URL. |
| Interrupted deletion and preserved records | The test committed an audio removal marker without acknowledging deletion. The worker retried, and an authenticated S3 HEAD returned 404 after completion. Transcript text, derived suggestions, mirror text, the revoked excerpt and their index copies were cleared. The approved decision and separately approved email excerpt stayed available. The redacted work audit retained its event ID, actor and timestamp. |
| Administration | Settings rendered without horizontal overflow at 1440, 1024, 390 and 320 CSS px. A stale policy update returned 409. Contributors received 404 for policy reads and writes. The app database role was denied direct policy table and purge function access. |

Workspace administrators manage retention and view deletion progress in Settings. Defaults are 90 days for audio, 365 for transcript revisions, 365 for imported revisions and 90 for audit details. Shorter meeting audio settings take precedence. The [retention documentation](../README.md#workspace-retention) defines a 30-day backup window. See [Feature 20 evidence](#feature-20-evidence) for the restore rehearsal and unexercised hosted lifecycle checks.

All Feature 19 acceptance checks passed locally. Features 20 and 21 have their prerequisites met.

## Feature 20 evidence

Verified locally on 2026-11-24 with Node 26.5.0, pnpm 10.34.9, Chromium, loopback OIDC and model fixtures, and separate PostgreSQL, Redis and SeaweedFS instances for the source and recovery environments.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including all 21 Vitest tests. The build reported the existing Zod annotations and Vite entry-chunk warnings. |
| `pnpm db:migrate` twice and `pnpm db:generate` | Fresh and repeated migrations passed. Drizzle found no schema changes. A populated Feature 19 upgrade preserved a restricted project and its runtime-role access. The previous worker function grants remained available. The app role could not query worker-only backlog metrics. |
| Docker targets `web`, `api`, `worker`, `migrate` | All four images built. The migration image initialized an isolated database, API and worker ran as UID 1000, and the worker emitted its backlog sample. Nginx served a client deep link, returned 404 for a missing asset, proxied readiness and returned 101 for a WebSocket Upgrade. Redis showed two API subscribers on the Socket.IO adapter channel and one after shutting down a replica. |
| `pnpm test:recovery --output=test-results/feature-20-recovery-complete` | The [recovery rehearsal](../tests/operations/recovery.spec.ts) passed. The API returned liveness 200 and readiness 503 while starting without Redis. It became ready after Redis started. The fixture model returned 503, the quota blocked a second call, and manual task editing succeeded during the outage. A SIGKILL and restart drained the queued synthetic job in **1.91 seconds**. |
| Restore and event counts | The restored database matched one workspace, one work item, three documents, one attachment, one comment, one pending execution, 16 audit events and 15 outbox rows before replay. The private attachment matched its SHA-256 and required sign-in. The feed returned the original event ID, the pending approval applied once using its original receipt, and the operator trace connected the source document to the effect audit ID. |
| Measured recovery | The local loss window was **0.408 seconds** against a 15-minute objective. One write deliberately made after the backup was absent. Recovery took **10.872 seconds** against a four-hour objective, including recovery infrastructure startup, restore, sign-in, object verification and queue replay. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-20-full-final` | All 26 Chromium tests passed. A focused rerun also passed the brief and meeting journeys after an earlier run stopped on a transcription fixture connection error. |

The [deployment and recovery runbook](../infra/deploy/README.md) documents rollout, rollback, credential recovery, scoped event replay and 30-day backup and noncurrent object retention settings. Managed WAL/PITR, backup lifecycle enforcement, recovery of production secrets, production TLS, production-scale restore, post-backup revocation replay and live provider reconciliation remain unexercised. No staging or production deployment took place.

All local Feature 20 acceptance checks passed. Feature 21 is ready.

The accessibility run found a Redis adapter startup race. Commit `5293e0d` prevents the Pub/Sub subscriptions from inheriting a command timeout. Six restarts against running Redis and the local recovery rehearsal passed after the correction.

## Feature 21 evidence

Verified on 2026-11-24 with macOS Chromium, loopback OIDC and model fixtures, and isolated PostgreSQL, Redis and S3-compatible storage. All screenshots use a synthetic workspace.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed, including all 21 Vitest tests. The build reported the existing Zod annotation and Vite entry-chunk warnings. |
| `pnpm test:e2e --project=foundation --project=accessibility --no-deps --workers=1 --trace=on --output=test-results/feature-21-final` | All 10 tests passed, including the [signed-in accessibility journey](../tests/e2e/accessibility-and-visual-qa.spec.ts). Primary controls remained reachable at 1440, 1024, 390 and 320 CSS px. Real 200% browser zoom yielded a 320 CSS px viewport for the signed-in review, forecast, search and transcript. Long source text wrapped inside its panel. |
| `pnpm test:e2e --project=foundation --project=planning --project=forecast --project=reviews --project=meetings --project=search --project=workspace-activity --no-deps --workers=1 --trace=on --output=test-results/feature-21-regression` | All 15 tests passed. The final foundation and accessibility run also passed after adjusting the skip link and conflict alert placement. |
| Keyboard and submission states | A keyboard task edit preserved its draft and Save focus after HTTP 503. Retrying saved the task and restored focus to Edit. Escape returned focus to its task row. Native keyboard selection added a dependency from the ordered list. Opening a milestone from the impact list and dismissing its details restored the scenario URL and originating link. A keyboard search opened its evidence and an unavailable citation showed an alert. A real approval version conflict focused the error and the next Tab reached **Review latest changes**. |
| Contrast and preferences | Minimum checked ratios were 5.21:1 for secondary text, 5.72:1 for the primary action, 6.15:1 for status text, 5.77:1 for focus and 3.10:1 for control outlines on the checked surfaces. Commitment, forecast, scenario impact and pending review each had explicit labels. Chromium emulation confirmed the reduced-motion transition and opaque rail with reduced transparency. |
| `pnpm test:recovery --output=test-results/feature-21-recovery-regression` | Passed after the Socket.IO startup correction. |

| View | Viewport | Verified task |
|---|---|---|
| Home | 1440 px | Compare the [empty workspace](evidence/feature-21/home-empty-1440.png) with [assigned work and pending reviews](evidence/feature-21/home-populated-1440.png). |
| Forecast | 1024 px | Compare the dates and return to the [focused milestone row](evidence/feature-21/forecast-impact-1024.png). |
| Search and evidence | 320 px | Read a [long source result](evidence/feature-21/search-long-source-320.png) and recover from an [unavailable citation](evidence/feature-21/evidence-unavailable-320.png). |
| Meeting | 390 px | Read speaker-attributed and unbroken [transcript passages](evidence/feature-21/meeting-transcript-390.png). |
| Review | 390 px and 200% browser zoom | Recover from a [version conflict](evidence/feature-21/approval-conflict-390.png) and reach [approval actions at 200%](evidence/feature-21/pending-review-200-percent.png). |

All Feature 21 acceptance checks passed locally. The verification used Chromium keyboard input and accessibility roles. Cross-browser and dedicated screen-reader sessions were unexercised. Feature 22 is ready.


## Groq provider verification

Verified on 2026-11-24 using synthetic inputs against live Groq and through Chromium with model fixtures and isolated PostgreSQL, Redis and S3-compatible storage.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All 20 Vitest tests passed. Groq tests covered structured brief requests, timestamped transcripts with a null speaker, cited answers from local results and rate-limit fallback. The build reported the existing Zod and Vite warnings. |
| `TEST_GROQ_BRIEFS=1 pnpm test:e2e --project=briefs --no-deps --workers=1 --output=test-results/groq-briefs` | Passed through the browser and worker. The Groq fixture checked the credential, model and structured request. A timeout preserved the brief, and the edited plan went through review before applying once. |
| `pnpm test:e2e --project=briefs --project=meetings --project=search --project=retention --no-deps --workers=1 --output=test-results/groq-regression` | All four tests passed with the existing provider fixtures. |
| Live Groq with synthetic inputs | The models endpoint accepted the configured key and listed both models. Cited search returned the expected source passage, and transcription returned timed segments from a synthetic recording. The live brief request initially returned 400 for its nullable deadline union. The updated provider schema accepted a dated task and an undated task, both grounded in the brief. |
| `pnpm test:e2e --project=briefs --no-deps --workers=1` with and without `TEST_GROQ_BRIEFS=1` | Both fixture variants passed after the deadline schema fix. All 20 Vitest tests, type checks, lint, formatting and build also passed. |

Configuring `GROQ_API_KEY` selects Groq for brief extraction, cited search and timestamped transcription. The API and worker use the local search index in Groq mode. See the [Groq setup](../README.md#groq-ai).

## Feature 22 evidence

Verified on 2026-11-24 against application revision `7398afb717caecd91ca8e2e6c7f42254235dcbff`. The [release evidence](evidence/feature-22/README.md) documents the workload, expected and observed journey outcomes, command lines and staging gaps.

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `git diff --check` | Passed. All 21 Vitest tests passed, including the five deterministic schedule cases. The web build reported the existing Zod and entry-chunk warnings. |
| `pnpm test:e2e --workers=3 --trace=on --output=test-results/feature-22-journeys-final` | All 27 Chromium tests passed with isolated Compose services and loopback providers. Includes the accessibility journey at four viewport widths and 200% browser zoom. |
| `pnpm test:recovery --output=test-results/feature-22-recovery` | Passed. RPO 0.302 seconds, RTO 10.515 seconds and worker catch-up 1.90 seconds. |
| `pnpm test:release:extraction` | Scored 30 synthetic briefs and 30 synthetic meeting excerpts. The loopback brief contract and grounding cases passed. Meeting rules matched 50/60 tasks, 30/35 owners, 30/30 dates and 0/30 dependencies. |
| Release search load | Reconciled 100,000 indexed sources and 120,000 chunks in the primary workspace plus 5,440 sources and 6,522 chunks across nine neighbors. The 1,000-request run returned 998 HTTP 503 errors. Ingress p95 on the two successful responses was 1,491 ms against a target below one second. |
| Search relevance | All 20 exact-ID API requests returned results. All 80 keyword and paraphrase API requests timed out. The SQL ranking diagnostic returned a labeled top-five hit for 60/100 lexical and exact, 80/100 vector and 100/100 combined queries with synthetic embeddings. |
| Isolation at release scale | Ten of eleven access probes passed with zero unauthorized outputs or writes in the completed probes. A warmed workspace-wide hybrid request returned HTTP 503 after revocation and remains inconclusive. |
| Audit reconciliation | 44/79 durable operation records fully linked. All 20 approved commands linked, including GitHub commands. The audit missed risk evaluation outcomes, weekly captures and one GitHub retry. |

The initial run identified search, audit and staging gaps. See the [remediation results](#feature-22-remediation) below.

## Feature 22 remediation

The working tree adds scoped search optimizations and durable audit outcomes. See the [release report](evidence/feature-22/README.md#remediation-results) for the baseline, device and database versions, latency split, and reproduction commands.

| Check | Result |
|---|---|
| Release-scale benchmark after a local PostgreSQL restore | All 1,000 requests returned ranked results in under one second. Ingress p50 was 199 ms, p95 was 353 ms, and p99 was 436 ms. All 100 labeled combined searches matched in the top five. All eleven isolation probes passed, with zero unauthorized outputs or writes observed. |
| Browser journeys and audit reconciliation | All 27 Chromium tests passed with loopback providers. The fixture reconciled 140/140 operation records, including 17 risk evaluations, 84 weekly captures and all four GitHub attempts. |
| Populated upgrade | The migrations preserved the fixture workspace and work, backfilled its existing embedding, denied raw vector reads to the runtime role, and removed the compact vector after clearing or deleting the chunk. A repeat migration and schema generation passed. |
| Fresh final-schema regression | On 2026-11-25, forecast, risks, GitHub, search, project health and retention all passed. The focused audit linked 34/34 records. The final local recovery drill measured an 11.161-second RTO, 0.594-second RPO and 1.90-second worker catch-up. |
| Static and unit checks | Type checks, lint, formatting, 21 Vitest tests, web build and diff checks passed. The web build emitted the existing Zod and entry-chunk warnings. |

Feature 22 remains blocked on the designated provider test accounts and staging environment. Use the [release issues](current-issues.md#feature-22-release-verification) to resume the live search and extraction checks, connected journeys, and timed staging restore.
