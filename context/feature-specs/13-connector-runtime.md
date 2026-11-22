# 13 · Connector management and ingestion

**Prerequisites** — [03](03-identity-and-tenancy.md), [04](04-projects-and-work.md), [07](07-documents-and-decisions.md)

## Implementation prompt

Give administrators a recoverable way to map external sources to authorized projects. Follow the [session workflow](../ai-workflow-rules.md).

Create installation records, encrypted token storage, scope and project mapping, cursor records, receipt deduplication and durable retryable ingestion. Support paused, syncing, healthy, failed and disconnected states. Provide an adapter interface for sync, normalization, entitlement checks and reconciliation.

Build settings showing destination, audience, last success and actionable errors. Keep private message content out of admin health views. On disconnect, cancel queued outbound work and invalidate mirrored data; expose revocation for explicit shares.

## Acceptance checks

- [ ] Replay one delivery twice and see one canonical source revision. A failed batch never advances the checkpoint.
- [ ] A revoked token pauses only its installation. An admin outside a private project can diagnose sync without reading content.
- [ ] A disconnected mirror becomes unavailable to readers before deferred cleanup finishes.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
