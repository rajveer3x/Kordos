# 08 · Approval engine and audit history

**Prerequisites** — [04](04-projects-and-work.md), [07](07-documents-and-decisions.md)

## Implementation prompt

Create a reviewable boundary for every consequential agent command and a receipt for each execution. Follow the [session workflow](../ai-workflow-rules.md).

Implement immutable proposal revisions, expiry, requester, reviewers, typed command parameters and target versions. Support draft, pending, approved, applying, applied, stale, rejected, expired, failed and reconciliation-required outcomes. Wire an internal work-item edit as the first real command.

Build Reviews and Audit screens. Show before/after values, affected items, evidence, actor and approval receipt. Edit invalidates previous approval. Recheck actor, source access and target versions at execution. Protect append-only audit data and redact restricted values by audience.

## Acceptance checks

- [ ] Two simultaneous approvals yield one applied effect. Retry returns the same receipt.
- [ ] Permission loss or changed target between review and execution prevents application and explains how to refresh.
- [ ] Trace a manual edit, a rejected proposal and an applied agent revision from the audit view.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
