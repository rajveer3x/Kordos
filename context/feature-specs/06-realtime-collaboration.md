# 06 · Comments and presence

**Prerequisites** — [04](04-projects-and-work.md)

## Implementation prompt

Let members discuss work in context and recover cleanly from a lost connection. Follow the [session workflow](../ai-workflow-rules.md).

Implement project and task threads, replies, edits, mentions and resolution. Provide a shared subject interface for document and meeting threads. Store comment, audit and outbox in one transaction. Use Socket.IO rooms scoped by effective project membership and Redis TTL heartbeats.

Render optimistic entries using client mutation IDs. Buffer live events while replaying the authorized change feed from a cursor, then deduplicate. Announce new comments without stealing focus. Invalidate rooms and caches after membership changes.

## Acceptance checks

- [ ] Two clients receive a comment once across a reconnect that overlaps replay and live broadcast.
- [ ] A user cannot join a private room through a guessed subject ID. Removing membership stops future events.
- [ ] An expired heartbeat removes presence while the saved comment remains visible.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
