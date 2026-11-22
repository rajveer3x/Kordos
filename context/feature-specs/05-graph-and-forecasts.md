# 05 · Dependencies and forecasts

**Prerequisites** — [04](04-projects-and-work.md)

## Implementation prompt

Make schedule impact inspectable and allow disposable what-if comparisons. Follow the [session workflow](../ai-workflow-rules.md).

Represent same-project finish-to-start edges with composite foreign keys. Reject cycles and show the conflicting path. Serialize graph edits under concurrency. Calculate affected nodes in topological order and run a backward pass for slack. Respect weekends, holidays, actual completion, remaining estimates and missing inputs.

Build a React Flow canvas and equivalent keyboard-operable ordered list. Present commitment, calculated forecast, affected owners, path and input revision. POST a versioned scenario without changing commitments. Later review features consume the scenario payload.

## Acceptance checks

- [ ] For Monday launch, Friday evening handoff plus two full QA days yields Wednesday morning. Changing handoff to Thursday yields Tuesday.
- [ ] A slip inside available slack preserves the milestone; a missing estimate marks the path uncertain.
- [ ] Concurrent opposite edges cannot form a cycle. Closing a scenario leaves the saved plan intact.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
