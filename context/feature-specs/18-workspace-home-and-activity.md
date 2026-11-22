# 18 · Workspace home and activity history

**Prerequisites** — [10](10-risk-from-activity.md), [11](11-meetings-and-actions.md), [12](12-inbox-and-deadlines.md), [14](14-github-activity-and-actions.md), [17](17-health-and-duplicates.md)

## Implementation prompt

Bring assignments, dates, decisions, risk and reviews together into daily workspace and project views. Follow the [session workflow](../ai-workflow-rules.md).

Compose authorized data from existing feature modules into home and overview. Give priority to unresolved decisions, time-sensitive risk and pending reviews. Link to canonical task details and source panels. Implement project activity with actor, source, type and cursor filters.

Use the UI reference translation for a quiet project title band, metric alignment and actionable rows. Show real empty states and avoid a second source of truth for counts. Keep archive, workspace switch and private-project membership consistent across rollups.

## Acceptance checks

- [ ] A lead sees a pending review while an ineligible viewer sees only accessible project activity.
- [ ] One approved action updates the relevant home row, project history and receipt with matching identifiers.
- [ ] Open a deep link on mobile, return, and recover the original filter and selection.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
