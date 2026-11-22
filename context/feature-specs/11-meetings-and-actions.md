# 11 · Meetings and accountable follow-up

**Prerequisites** — [06](06-realtime-collaboration.md), [07](07-documents-and-decisions.md), [08](08-approvals-and-audit.md), [09](09-brief-to-plan.md)

## Implementation prompt

Take a project meeting from authorized recording or text to confirmed decisions and assigned work. Follow the [session workflow](../ai-workflow-rules.md).

Support manual meeting creation, agenda, private upload or pasted transcript, processing progress and retry. Transcribe in a worker with timestamped segments and optional speakers. Allow corrections, preserve revisions, and flag affected suggestions.

Extract decisions, candidate actions and open questions with precise anchors. Accept individual items via approved commands, create linked tasks, and display later completion on the meeting. Support inherited permissions, discussion threads and retention.

## Acceptance checks

- [ ] A confirmed action opens its exact audio segment and links back from the resulting task.
- [ ] “Ask Maya about rollout” leaves ownership unresolved. Reprocessing preserves approved items and avoids duplicates.
- [ ] Removing media or membership updates availability while preserving permitted decision history.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
