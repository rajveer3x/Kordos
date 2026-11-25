# Feature 22 release verification

Verification ran against application revision `7398afb717caecd91ca8e2e6c7f42254235dcbff` with the Feature 22 harness in the working tree. The initial run is preserved below. See the [remediation results](#remediation-results) for the latest local verification and the [issue log](../../current-issues.md#feature-22-release-verification) for open staging checks.

## Reproduce the evidence

From the repository root, install the frozen workspace dependencies and Playwright Chromium. The search and journeys launchers each create and remove their own Compose stack. The search run uses the same API search route, PostgreSQL authorization, and worker chunker as the application. The HTTP embedding fixture uses 512-dimensional vectors. Bulk loading the remaining synthetic vectors keeps the timed benchmark focused on query processing. Set `RELEASE_WORKER_EMBEDDINGS=1` to time the normal worker path for every vector against the test timeout.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
bash infra/release/run.sh search
bash infra/release/run.sh journeys --trace=on
pnpm test:release:extraction
pnpm test:recovery
```

The search run emits a summary, 1,000 request samples and 100 labels with their top-five results in the Playwright JSON report. The journey run checks audit completeness and emits per-test outcomes and the reconciliation under `test-results/`. The extraction command emits per-case expected and observed values and aggregate precision and recall. To score a live brief model, supply `RELEASE_GROQ_API_KEY` from a designated test account and optionally set `RELEASE_GROQ_MODEL`. The fixture brief score measures the provider contract and grounding against controlled output.

## Search corpus and environment

The reproducible seed is `kordos-release-22-v1`. The run used Apple M5 macOS arm64 with 10 logical CPUs and 16 GiB of host memory. Docker exposed 10 CPUs and 7.75 GiB. Node was 26.5.0, PostgreSQL 17.12, pgvector 0.8.7 and the database had all 19 migrations through `0018_operations`. The HTTP query and index model was `search-embeddings-fixture` with 512 dimensions. Provider fees were $0. This run used local compute and loopback calls.

| Source kind | Primary workspace sources | Primary chunks | Neighbor sources | Neighbor chunks |
|---|---:|---:|---:|---:|
| Work | 70,000 | 70,000 | 3,819 | 3,819 |
| Documents | 20,000 | 40,000 | 1,082 | 2,164 |
| Meetings | 10,000 | 10,000 | 539 | 539 |
| **Total** | **100,000** | **120,000** | **5,440** | **6,522** |

The nine neighbors contained 2,048, 1,024, 768, 512, 384, 256, 192, 128 and 128 objects. Every indexed object matched its current canonical revision, revision 1, and all 126,522 chunks had a vector. The run resumed the isolated stack after the worker chunker had processed most sources and used the fixture vectors for the remaining embedding backlog. The timed search ran after indexing drained.

Ten independent sessions sent 500 first-touch requests and repeated the same workload for 500 warm requests. The query set included exact identifiers, keywords and paraphrases, with workspace-wide and project-scoped queries and source-kind and owner filters. The cold and warm labels refer to the in-process query embedding cache. The corpus and database were warm after indexing and statistics collection.

The 1,000 requests yielded two HTTP 200 responses and 998 HTTP 503 responses due to PostgreSQL statement timeouts (SQLSTATE `57014`). The p95 target was missed. Across all completions, including errors, ingress p50, p95 and p99 were 2,054, 3,271 and 3,792 ms.

| Phase | Requests | HTTP 200 | HTTP 503 | Successful ingress p50 | p95 | p99 | Embedding cache hits |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cold | 500 | 0 | 500 | — | — | — | 0/402 |
| Warm | 500 | 2 | 498 | 1,449 ms | 1,491 ms | 1,491 ms | 393/402 (97.8%) |
| **Total** | **1,000** | **2** | **998** | **1,449 ms** | **1,491 ms** | **1,491 ms** | **393/804 (48.9%)** |

The successful-response percentiles represent two observations. The cache denominator covers embedding-eligible requests. The remaining 196 requests used exact IDs.

The separate relevance run sent 100 labeled searches through the API. All 20 exact-ID requests returned HTTP 200. All 40 keyword and 40 paraphrase requests timed out, so the API could supply a relevant top-five result for at most 20 of the 100 labels against the target of 85.

The ranking diagnostic reran those labels through the application's PostgreSQL function with the runtime role and JIT disabled for the session. The fixed fixture returned a relevant top-five result for **60/100** labels using lexical and exact retrieval, **80/100** using vector retrieval, and **100/100** using the combined ranked function. The separate diagnostic omits the HTTP response deadline and uses predictable synthetic embeddings. The end-to-end relevance target remains open.

A scoped diagnostic single-query sample took 879 ms for lexical retrieval with PostgreSQL JIT enabled and 4 ms with session-local JIT disabled. The hybrid plan still examined 120,000 candidate chunks for the workspace-wide sample and took 806 ms in `EXPLAIN ANALYZE` with JIT disabled. JIT overhead and broad exact vector scanning remain performance work.

## Isolation

The browser suite passed cross-tenant and restricted-project checks for reads, writes, socket rooms, citations, private attachments, worker application and cached views. The release-scale follow-up passed 10 of 11 access probes. A neighboring user saw only the permitted project. Foreign-tenant search and ungranted project search returned 404. After the lead revoked project access, the warmed project-filtered search and direct read returned 404, a workspace exact-ID search returned zero results, and the denied write left the canonical project at its original version. No unauthorized outputs or writes were observed in the completed probes.

The warmed workspace-wide hybrid search returned HTTP 503 after revocation, leaving that case inconclusive at release scale. The original load run retained ingress results for all 1,000 requests. Its workspace-wide pre-revocation probe timed out before the response-content summary was attached.

## Extraction evaluation

Thirty synthetic briefs and 30 synthetic meeting excerpts were labeled for tasks, explicit owners, dates and finish-to-start dependencies. A task matched when its title included the labeled action and work subject. Owner, date and dependency matches required the expected field and task association.

| Corpus | Field | True positives | False positives | False negatives | Precision | Recall |
|---|---|---:|---:|---:|---:|---:|
| Briefs, loopback fixture | Tasks | 60 | 0 | 0 | 100% | 100% |
| Briefs, loopback fixture | Owners | 35 | 0 | 0 | 100% | 100% |
| Briefs, loopback fixture | Dates | 15 | 0 | 0 | 100% | 100% |
| Briefs, loopback fixture | Dependencies | 30 | 0 | 0 | 100% | 100% |
| Meetings, production transcript rules | Tasks | 50 | 0 | 10 | 100% | 83.3% |
| Meetings, production transcript rules | Owners | 30 | 0 | 5 | 100% | 85.7% |
| Meetings, production transcript rules | Dates | 30 | 0 | 0 | 100% | 100% |
| Meetings, production transcript rules | Dependencies | 0 | 0 | 30 | — | 0% |

Both sets produced zero invented assignees and zero unsupported dates. The meeting extractor missed “We need someone to …” tasks and currently emits no dependency candidates. The live brief quality run remains pending.

## Recovery

The local [recovery rehearsal](../../../tests/operations/recovery.spec.ts) passed. Measured RPO was **0.302 seconds** and RTO was **10.515 seconds** against objectives of 15 minutes and four hours. After SIGKILL and restart, the worker caught up in **1.90 seconds**. The restored counts matched one workspace, one work item, three documents, one attachment, one comment, one pending execution, 16 audit events and 15 outbox rows. One deliberately post-backup marker was absent. One attachment matched its original contents and authentication requirement, one event retained its ID and the pending approval applied once. The suite also exercised Redis startup and continued manual edits through a model outage. The timed restore ran on local Compose infrastructure. A staging restore and the post-restore release-scale workload remain pending.

## Audit reconciliation

The SQL reconciled **44 of 79 durable operation records (55.7%)** against the 100% target. It links proposal approvals to their immutable revision, reviewer, source and outcome, and links brief and meeting attempts to source revisions and terminal events. Weekly report counts represent the latest saved snapshot per project and period. One browser-test snapshot copied directly into the previous week is excluded.

| Operation | Linked | Records observed |
|---|---:|---:|
| Approved commands | 20 | 20 |
| Brief attempts | 5 | 5 |
| Meeting attempts | 10 | 10 |
| GitHub execution claims | 3 | 4 |
| Automated risk evaluations | 6 | 17 |
| Weekly report snapshots | 0 | 23 |
| **Total** | **44** | **79** |

The GitHub suite published two comments for its distinct successful approvals. The forced timeout produced one publication for its receipt after a second claim, whose audit could only be traced through the aggregate claim count. Eleven risk jobs had a processing timestamp and no source-version outcome event. Weekly snapshots preserve their input and provenance data in PostgreSQL without a corresponding actor-attributed run event. The denominator covers the operation classes shown. Historical report refresh attempts and unrecorded model requests have no complete durable inventory, so overall audit coverage remains unverified.

## Release journeys

All 27 Chromium tests passed against PostgreSQL, Redis, private S3-compatible storage, and loopback provider fixtures. An initial Compose invocation targeted the default Redis service during the outage test. Redis was restarted, and the passing run used an explicit isolated Compose project for the outage. Tests used independent browser contexts for roles and project membership. The table records what the fixture suite observed and the connected evidence still required.

| Journey | Expected | Observed locally | Open check |
|---|---|---|---|
| Onboard and work together | Invite a contributor and viewer, reconcile concurrent comments and reconnect, reject a stale document edit, and revoke project access. | Invitation and scope checks passed. Replay preserved one copy of each comment, stale document writes returned a version conflict and the revoked account lost access and live presence. [Identity](../../../tests/e2e/identity-tenancy.spec.ts), [real-time](../../../tests/e2e/realtime-collaboration.spec.ts), [documents](../../../tests/e2e/documents-and-decisions.spec.ts) | Link the tests in one release run using the designated identity provider. |
| Plan and reforecast | Approve a branched brief, compare delays with and without slack, and apply the reviewed change once. | The brief produced three candidate edges and one approved effect. Forecasts displayed the expected branch and dates. A delay with slack left the forecast unchanged and a delay beyond slack moved it. [Brief](../../../tests/e2e/brief-to-plan.spec.ts), [forecast](../../../tests/e2e/dependencies-and-forecasts.spec.ts), [replan](../../../tests/e2e/project-activity-risks.spec.ts) | Repeat from the same imported brief using the release model. |
| Capture and retrieve a decision | Attach a calendar event, transcribe audio, approve a task and decision, and retrieve them with a passage that becomes unavailable on revocation. | Calendar kept the attached meeting and accepted decision through cancellation. Meeting audio supported exact passage playback and reviewed follow-up. Hybrid retrieval returned exact transcript text and hid revoked sources. [Calendar](../../../tests/e2e/calendar-and-gmail.spec.ts), [meeting](../../../tests/e2e/meetings-and-actions.spec.ts), [search](../../../tests/e2e/hybrid-search.spec.ts) | Complete the calendar-to-search sequence on the same meeting with test provider accounts. |
| Connect external work | Mirror one selected PR and one shared message, replay deliveries, and recover a cursor without duplicates or unrelated messages. | The GitHub fixture converged on the selected revision and rejected invalid delivery. Google fixtures recovered expired Calendar and Gmail cursors and shared only the approved excerpt. [GitHub](../../../tests/e2e/github-activity-and-actions.spec.ts), [Google](../../../tests/e2e/calendar-and-gmail.spec.ts) | Run against a GitHub test installation and selected calendar and Gmail test accounts. |
| Run team operations | Deliver the deadline reminder to the eligible recipient, suppress the old reminder after rescheduling, cite weekly health and preserve duplicate history. | Quiet-hour and email delivery tests passed. The weekly snapshot resolved authorized citations. Consolidation kept the retired task, discussion, audit and dependency history and rejected cycles. [Inbox](../../../tests/e2e/inbox-and-deadlines.spec.ts), [health](../../../tests/e2e/health-and-duplicates.spec.ts) | Repeat as one sequence with the designated mail delivery account. |
| Prove authorized execution | Reconcile an ambiguous timeout to one PR comment and trace it to reviewer, proposal revision, source and receipt. | The loopback GitHub provider received one publication for the timed-out approval. The final receipt linked its effect and source revision. A revoked destination produced a stale result. [GitHub execution](../../../tests/e2e/github-activity-and-actions.spec.ts) | Repeat with an authorized test repository and close the per-claim audit gap. |
| Operate the deployment | Restore durable data, restart workers, remove connector access and repeat the isolation and ranked search checks after recovery. | Local restore replayed the queue, preserved the private attachment, and stayed inside RPO and RTO objectives. Connector disconnect invalidated live mirrors. [Recovery](../../../tests/operations/recovery.spec.ts), [connectors](../../../tests/e2e/connectors.spec.ts) | Repeat the connector, tenant and search checks on the restored staging stack. |

## Schedule and accessibility

All five deterministic [schedule tests](../../../packages/domain/src/forecast.test.ts) passed. Friday handoff produced Wednesday 2026-11-25 and Thursday handoff produced Tuesday 2026-11-24 against the same Monday commitment. Delaying a parallel handoff by one day consumed one day of slack and kept the milestone on 2026-11-19. The nonworking Monday case produced a Thursday 2026-11-26 launch. The unknown estimate case kept its forecast provisional, and the branching graph returned the expected ordered path.

The [accessibility journey](../../../tests/e2e/accessibility-and-visual-qa.spec.ts) passed at 1440, 1024, 390 and 320 CSS px and at 200% Chromium zoom. Visually inspected the reviewed approval actions at 200% and the ordered impact path at 320 px from this run. Keyboard focus, retry and stale-review checks passed. See the [Feature 21 screenshots and contrast results](../../progress-tracker.md#feature-21-evidence) for the same application revision.

## Remediation results

Search still scores full-precision vectors exactly. Compact rows store the vectors inline so distance scans read fewer pages. Ranked candidates pass project scope, connector grants, retention, and pending-revision checks before ranking. The indexing indicator starts with the scoped queue, which avoids reading source and audit history when the queue is empty. Weekly capture resolves each assigned owner once and holds a project lock that permits unrelated search foreign-key checks. [pgvector inline storage documentation](https://github.com/pgvector/pgvector/tree/v0.8.7#why-isnt-a-query-using-a-parallel-table-scan)

The first passing release-scale benchmark loaded a backup of the indexed fixture corpus into a fresh local stack, migrated it through 0023 and used the same 1,000-query workload and ten signed-in users. The primary workspace covered 100,000 sources and 120,000 chunks. Nine neighbors added 5,440 sources and 6,522 chunks. The loopback provider cost was $0. The index rebuild used the application worker and two supplementary workers before timing began.

| Query cache phase | Requests | HTTP 200 | HTTP 503 | Ingress p50 | p95 | p99 | Embedding cache hits |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cold | 500 | 499 | 1 | 333 ms | 732 ms | 1,654 ms | 0/402 |
| Warm | 500 | 500 | 0 | 322 ms | 676 ms | 973 ms | 402/402 |
| **Total** | **1,000** | **999** | **1** | **331 ms** | **694 ms** | **1,161 ms** | **402/804 (50%)** |

979 of 1,000 requests returned ranked results within one second. Combined search returned a labeled top-five match for **100/100** through the API. Lexical and exact retrieval matched **60/100**, and vector retrieval matched **80/100**, using the same synthetic model. All eleven release-scale access probes passed, including warmed workspace search after revocation. The load and targeted probes observed zero unauthorized outputs or writes. The local result is in test-results/feature-22-remediation-final/playwright.json.

A second run used the restored corpus and ran without the browser suite in parallel. All **1,000/1,000** requests returned ranked results in under one second, with zero errors or hybrid fallbacks. The API again matched **100/100** labels, all eleven access probes passed, and the run observed zero unauthorized outputs or writes.

| Isolated cache phase | Requests | Ingress p50 | p95 | p99 | Embedding cache hits |
|---|---:|---:|---:|---:|---:|
| Cold | 500 | 198 ms | 372 ms | 629 ms | 0/402 |
| Warm | 500 | 199 ms | 342 ms | 360 ms | 402/402 |
| **Total** | **1,000** | **199 ms** | **353 ms** | **436 ms** | **402/804 (50%)** |

Timing includes the loopback provider when the query vector is uncached. The Playwright result and request samples are in test-results/feature-22-remediation-isolated/playwright.json. Both reruns used PostgreSQL 17.12 and pgvector 0.8.7 on the same Apple M5 host. The restored fixture contained all 126,522 compact vector rows.

The browser journey suite passed all **27** tests. Audit reconciliation rose from 44/79 to **140/140** for the measured operation classes. The latest denominator includes every recorded weekly capture and both the start and outcome of individual GitHub attempts.

| Operation | Linked | Records observed |
|---|---:|---:|
| Approved commands | 20 | 20 |
| Brief attempts | 5 | 5 |
| Meeting attempts | 10 | 10 |
| GitHub execution attempts | 4 | 4 |
| Automated risk evaluations | 17 | 17 |
| Weekly report captures | 84 | 84 |

Risk evaluations record outcomes even when they produce no finding or the source changed. Weekly captures retain the actor, input revision and outcome of each run. GitHub attempts bind the reviewer, source revision and approval receipt to the outcome of each lease, including retries and recovered interruptions. These metadata-only records are included in the [operator trace](../../../infra/recovery/trace.sql). Historical operations retain the evidence that existed when they ran.

The populated migration smoke test preserved tenant and work records and backfilled existing embeddings. Scoped search found the original work ID. Clearing or deleting a chunk removed its compact vector, and the runtime role had no direct vector read grant. Fresh and repeated migrations passed. Drizzle reported no schema drift. The local recovery rerun with the audit and vector migrations recovered in **11.264 seconds** with a **0.379-second** loss window. Worker catch-up took **1.90 seconds**.

On 2026-11-25, six focused Chromium journeys passed on a fresh stack through migration 0023. The focused reconciliation linked 34/34 operation records. The recovery rehearsal on the full migration set recorded an **11.161-second** RTO, a **0.594-second** RPO and **1.90 seconds** of worker catch-up. Type checks, lint, formatting, 21 Vitest tests and the web build passed. The existing Zod and entry-chunk build warnings remain.

The designated live-provider journeys, live search model measurements, and timed staging restore remain open.
