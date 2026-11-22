# 14 · GitHub activity and approved comments

**Prerequisites** — [08](08-approvals-and-audit.md), [13](13-connector-runtime.md)

## Implementation prompt

Connect selected repositories and let an authorized lead publish an exact reviewed update. Follow the [session workflow](../ai-workflow-rules.md).

Implement GitHub App installation mapping, validated webhooks, ingestion of issues, PR changes and merges, and repair of missed events. Link using explicit work IDs or a confirmed match. Add PR evidence to task details and activity feed.

Enable a reviewed issue or PR comment with the exact repository, destination and body visible. Recheck destination permissions, store delivery intent, reconcile uncertain outcomes via provider evidence, and persist the remote receipt. Use fixtures or a designated test installation.

## Acceptance checks

- [ ] Duplicate and out-of-order webhook deliveries converge to the correct PR state.
- [ ] Approving a comment on repository A cannot authorize a post on B. Remove destination access before execution and verify refusal.
- [ ] Simulate provider acceptance followed by timeout; one published comment can be traced back to one approved revision.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
