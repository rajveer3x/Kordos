# 04 · Projects and work items

**Prerequisites** — [03](03-identity-and-tenancy.md)

## Implementation prompt

Ship real projects and tasks through a project directory, list, board and detail route. Follow the [session workflow](../ai-workflow-rules.md).

Create restricted-by-default projects, workspace-visible mode with audience preview, project member roles, working calendar, tasks and milestones. Implement creation, edit, archive, reopen and role-scoped owner selection. Expose search/filtering within authorized projects.

Reuse a task inspector across views. Persist status independently of a blocker reason and resolution. Require a lead for milestone commitments and visibility changes. Use version checks, audit and domain events. The home view begins with assigned work.

## Acceptance checks

- [ ] A task edited on the board updates list and detail after refresh. Two concurrent edits surface a conflict with the draft retained.
- [ ] A workspace admin outside a private project sees no task titles. Archived work leaves active rollups.
- [ ] Reopen a completed task and verify attribution and prior state in its history. Task URLs resolve after refresh.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
