# 19 · Retention and access lifecycle

**Prerequisites** — [13](13-connector-runtime.md), [15](15-calendar-and-gmail.md), [16](16-hybrid-search.md), [17](17-health-and-duplicates.md), [18](18-workspace-home-and-activity.md)

## Implementation prompt

Give workspace administrators enforceable retention controls and members predictable access after a share changes. Follow the [session workflow](../ai-workflow-rules.md).

Define workspace retention settings for audio, transcripts, imported sources and logs with expiry jobs, durable deletion state and a documented backup window. Remove obsolete files, index entries and derived excerpts, while retaining permitted redacted audit facts.

Review mirrored source entitlement checks, explicit share revocation, worker identities, sockets, caches, notification payloads and private download paths. Use authenticated proxy delivery for immediately revocable files. Expose safe administration and deletion progress.

## Acceptance checks

- [ ] Revoke one source while its search result, signed access path and weekly summary are open. Subsequent requests expose no private content.
- [ ] Replay an interrupted purge and verify all scheduled representations converge without deleting separately authorized records.
- [ ] An auditor can still identify who acted and when without recovering removed source text.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
