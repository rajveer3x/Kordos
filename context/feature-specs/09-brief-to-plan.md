# 09 · Brief to approved project plan

**Prerequisites** — [05](05-graph-and-forecasts.md), [07](07-documents-and-decisions.md), [08](08-approvals-and-audit.md)

## Implementation prompt

Convert a messy product brief into an editable, sourced task and dependency proposal. Follow the [session workflow](../ai-workflow-rules.md).

Implement a schema-validated text model adapter, async brief job and structured output with candidate IDs, owners, durations, deadlines, dependencies and source spans. Verify quotes, resolve relative dates against the source timestamp, and mark missing or inferred values.

Offer split, rename, remove and add in plan review. Validate memberships and the edited graph. Commit the accepted set atomically through approvals. Expose job status, bounded retry and manual planning when the provider fails.

## Acceptance checks

- [ ] A brief with three branches yields editable candidates linked to supporting passages. An unspecified reviewer stays unassigned.
- [ ] An edited plan with a cycle cannot commit; correction succeeds with one approved transaction and audit receipt.
- [ ] A timeout keeps the brief. Retrying the job or approval never creates duplicate tasks.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
