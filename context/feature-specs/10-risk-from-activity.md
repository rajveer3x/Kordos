# 10 · Risks from project activity

**Prerequisites** — [05](05-graph-and-forecasts.md), [06](06-realtime-collaboration.md), [08](08-approvals-and-audit.md), [09](09-brief-to-plan.md)

## Implementation prompt

Turn an engineer’s delay report into a sourced, provisional forecast a lead can act on. Follow the [session workflow](../ai-workflow-rules.md).

Consume comment revisions and extract candidate task, timing and supporting quote. Restrict matching to visible work and ask the author to disambiguate. Reuse the scheduling engine for deterministic impact. Store versioned finding, path, calendar and input revisions.

Add ranked risks to project overview with evidence and scenario comparison. Lead can acknowledge, resolve or submit a specific replan for approval. Supersede a finding when the source changes, retain history, and emit events when severity changes.

## Acceptance checks

- [ ] A Friday API delay identifies QA and Wednesday launch while the commitment stays Monday until approved.
- [ ] Two tasks named Auth prompt clarification. An unrelated late copy edit creates no new milestone delay.
- [ ] Edited evidence supersedes the earlier forecast and a stale proposal must refresh.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
