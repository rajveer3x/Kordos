# 15 · Calendar events and shared email

**Prerequisites** — [11](11-meetings-and-actions.md), [13](13-connector-runtime.md)

## Implementation prompt

Bring selected meetings and messages into a project with explicit sharing boundaries. Follow the [session workflow](../ai-workflow-rules.md).

Implement Google OAuth with selected calendars and Gmail project label. Persist calendar sync tokens after all pages succeed and recover expired cursors with scoped resync. Process event updates and cancellations while preserving reviewed decisions.

Preview labeled mail and require selection of individual messages with project audience and excerpt. Persist share attribution and revocation separately from private mirrors. A new reply requires a new share. Use history-based incremental sync with fallback rescan.

## Acceptance checks

- [ ] A canceled event updates its meeting without erasing confirmed decisions. Calendar attendance grants no workspace access.
- [ ] Sharing one email makes only its approved excerpt project-visible. A later personal reply stays private.
- [ ] Expire both cursors and verify a scoped rebuild without duplicate meetings or unapproved messages.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
