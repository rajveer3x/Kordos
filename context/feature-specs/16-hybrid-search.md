# 16 · Permission-aware hybrid search

**Prerequisites** — [07](07-documents-and-decisions.md), [11](11-meetings-and-actions.md), [14](14-github-activity-and-actions.md), [15](15-calendar-and-gmail.md)

## Implementation prompt

Let a user find a task, document passage, meeting decision, PR or shared email across a workspace. Follow the [session workflow](../ai-workflow-rules.md).

Index canonical objects by revision using transactional outbox events. Chunk long content at headings or speaker turns. Store provenance, model version and effective visibility. Implement authorized full-text and pgvector candidate retrieval, reciprocal rank fusion, grouping by parent and source deep links.

Build a URL-addressable search page with project, type, owner and date filters, snippets, index status, empty results and error recovery. Support exact IDs without a model call. Offer an optional cited answer as a second operation.

## Acceptance checks

- [ ] A paraphrase retrieves the labeled decision and exact PR IDs work during an embedding outage.
- [ ] Private sources never enter counts, snippets or model context. Revocation hides stale indexed text immediately.
- [ ] Conflicting evidence is dated and attributed; insufficient evidence returns the available passages.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
