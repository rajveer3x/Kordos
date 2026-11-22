# 17 · Weekly health and duplicate review

**Prerequisites** — [08](08-approvals-and-audit.md), [10](10-risk-from-activity.md), [12](12-inbox-and-deadlines.md), [16](16-hybrid-search.md)

## Implementation prompt

Help leads decide what to do next using a cited weekly report and explainable duplicate suggestions. Follow the [session workflow](../ai-workflow-rules.md).

Generate weekly project reports in project time from deterministic counts, milestone slack, completed work, blockers and decisions needed. Record period, input revisions and freshness. Restrict derived text to permitted evidence and revalidate access when displaying historical reports.

Rank similar open tasks with retrieval, then compare deliverables and differences. Let members dismiss, link as related or propose consolidation. Preserve histories and predecessor relationships and revalidate cycles before an approved consolidation.

## Acceptance checks

- [ ] A late task with slack does not turn a healthy milestone red. Missing estimates show uncertainty.
- [ ] Every material report claim opens an authorized source, and revoked inputs no longer expose private text.
- [ ] A dismissed pair stays dismissed for the same revisions. Consolidation preserves history and cannot introduce a cycle.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
