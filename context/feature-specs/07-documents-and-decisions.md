# 07 · Documents and decision register

**Prerequisites** — [04](04-projects-and-work.md), [06](06-realtime-collaboration.md)

## Implementation prompt

Preserve versioned knowledge, confirmed decisions and stable evidence links. Follow the [session workflow](../ai-workflow-rules.md).

Implement document creation, rich-text editing with sanitized rendering, attachments, revision history, anchored comments, restore-as-new-revision and archive. Preserve unsaved text when a concurrent save conflicts. Add a shared citation resolver for comment IDs, immutable document spans and other source types as they arrive.

Build the decision register with question, conclusion, accountable person, effective date, evidence and optional superseding decision. Contributors draft; project leads confirm. Reauthorize source access at read time, including private downloads.

## Acceptance checks

- [ ] A historic quote still opens the correct revision after a document edit. A stale writer compares and recovers their draft.
- [ ] A confirmed decision remains traceable after being superseded. An unauthorized member cannot infer its private evidence.
- [ ] An attachment download is authorized per request; revocation suppresses protected evidence text.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
