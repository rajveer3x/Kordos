# 22 · Full release evidence

**Prerequisites** — [16](16-hybrid-search.md), [17](17-health-and-duplicates.md), [18](18-workspace-home-and-activity.md), [19](19-privacy-and-retention.md), [20](20-operability-and-delivery.md), [21](21-accessibility-and-visual-qa.md)

## Implementation prompt

Demonstrate the entire v1 product against reproducible release criteria. Follow the [session workflow](../ai-workflow-rules.md).

Seed at least 100,000 distinct searchable objects in one workspace plus nine populated neighbors. Record source/chunk counts and versions. Run 1,000 mixed queries at ten concurrent users with real access filters. Measure ingress to ranked response including query embeddings. Record p50/p95/p99, errors, cold/warm splits, cache rates, hardware and cost.

Label 100 search queries and target a relevant result in the top five for at least 85. Score extraction by field on 30 briefs and 30 meeting excerpts. Reconcile every attempted agent action/run against actor, evidence, revision, outcome and receipt as applicable. Exercise the final specification’s release journeys using test installations and two browser sessions.

## Acceptance checks

- [ ] Report whether ranked-search p95 is below one second. Publish observed measurements and failed targets honestly.
- [ ] Verify zero unauthorized outputs or writes across tenant, private-project and revocation cases. Report exact audit coverage against the 100% target.
- [ ] Record recovery drill, schedule fixtures, accessibility evidence and all seven end-to-end release journeys with revision, expected and observed results.

## Release decision

Mark v1 complete when the assembled application passes all seven journeys on the release revision and meets the release targets in the [final product specification](../../Team%20Workspace%20Final%20Product%20Specification.docx). Verify connected workflows with provider test accounts and the running API, workers and storage. If a journey fails, a target is missed or a required check is unrun, link it from the [issue log](../current-issues.md) and keep release verification open until it passes.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
