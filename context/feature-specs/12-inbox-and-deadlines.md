# 12 · Inbox and deadline delivery

**Prerequisites** — [06](06-realtime-collaboration.md), [08](08-approvals-and-audit.md), [10](10-risk-from-activity.md)

## Implementation prompt

Deliver useful work notifications once to the right person at the right time. Follow the [session workflow](../ai-workflow-rules.md).

Create durable recipient-scoped inbox entries for assignment, mention, review, risk, approaching due date and overdue escalation. Add read state, filters, quiet hours, email/digest/in-app preferences and stable authorized links. Surface pending reviews, due work and risks on home.

Schedule in project time, deliver according to recipient timezone, and recheck status, deadline revision, membership and quiet hours immediately before send. Deduplicate by recipient, subject, reason and revision. Use a local email sink during development.

## Acceptance checks

- [ ] Changing a deadline during quiet hours yields one reminder for the new deadline. Completed and archived work suppresses old jobs.
- [ ] Read state syncs across sessions. Failed email delivery preserves the in-app notification.
- [ ] Revocation suppresses queued private excerpts and a resolved risk remains traceable to members.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
