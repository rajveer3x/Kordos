# 21 · Accessibility and visual verification

**Prerequisites** — [18](18-workspace-home-and-activity.md), [19](19-privacy-and-retention.md)

## Implementation prompt

Verify the original visual direction across real workflows and dense operating screens. Follow the [session workflow](../ai-workflow-rules.md).

Review populated and empty home, project forecast, search, meeting transcript and approval pages using ui-context.md. Exercise a keyboard-only task edit, dependency edit via list, source lookup, approval conflict, dialog dismissal and submission error recovery.

Check zoom, contrast, long labels, graph alternatives, focus restoration, reduced motion, accessible names and status announcements. Inspect desktop, tablet, mobile and narrow reflow sizes. Fix shared components at their owner and rerun affected journeys.

## Acceptance checks

- [ ] At 1440, 1024, 390 and 320 CSS px all primary actions remain reachable. Long source text wraps or scrolls locally.
- [ ] Commitment, forecast and pending proposal remain distinguishable without color. A keyboard user can trace impact and return to the originating row.
- [ ] Record representative screenshots, viewport, task and results using synthetic data.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
