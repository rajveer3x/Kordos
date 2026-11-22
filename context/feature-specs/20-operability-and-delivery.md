# 20 · Deployment and recovery

**Prerequisites** — [12](12-inbox-and-deadlines.md), [14](14-github-activity-and-actions.md), [15](15-calendar-and-gmail.md), [19](19-privacy-and-retention.md)

## Implementation prompt

Make the system deployable, observable and recoverable across API, worker and storage failures. Follow the [session workflow](../ai-workflow-rules.md).

Prepare static client deployment and separate API/worker container targets. Document TLS/WebSocket ingress, shared Socket.IO adapter, polling affinity if enabled, environment separation, secret management and backward-compatible migrations.

Instrument source-to-execution traces, queue age, lag, retry counts, provider latency/cost and per-tenant quotas. Provide actionable runbooks for worker crash, expired credentials, restore, rollback and event replay. Keep live deployments explicitly authorized.

## Acceptance checks

- [ ] In an authorized staging environment or documented rehearsal, restore database and storage, replay events and reconcile counts.
- [ ] Verify manual editing during model outage and queued catch-up after worker restart.
- [ ] Record measured recovery and compare with 15-minute database-loss and four-hour recovery objectives; classify unexercised steps.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
