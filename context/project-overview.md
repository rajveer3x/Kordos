# Kordos · Product context

Kordos is the AI workspace for software teams. Use `kordos` as the repository slug. A new release owner should be able to answer “What did we promise, what changed, who owns the next step, and where is the evidence?” from the same multi-tenant workspace where the team does the work.

Start a build from the [progress tracker](progress-tracker.md). Each linked feature file is an implementation prompt. The [final product specification](../Team%20Workspace%20Final%20Product%20Specification.docx) defines v1 scope. The older blueprint supplies example data and a video sequence.

## The working model

| Concept | Meaning in this product |
|---|---|
| Commitment | A date or action the team has authorized. Keep its revision and author. |
| Forecast | A calculation using a named calendar, graph revision, evidence and estimates. Mark provisional inputs. |
| Scenario | A private, disposable change to a baseline. It becomes a shared proposal only when submitted. |
| Proposal | A versioned set of exact changes an eligible reviewer can accept, edit or reject. |
| Evidence | A permitted, addressable source revision and span, timestamp or external ID. |
| Decision | A confirmed conclusion with an accountable person, effective date and supporting sources. Later decisions may supersede it. |

## People and visibility

Workspace members can belong to multiple tenants. Viewers read authorized material. Contributors create work, collaborate and draft proposals. Project leads manage access, confirm decisions and approve consequential changes. Workspace administrators manage membership, configuration and connector health. Reading a private project requires project membership even for administrators. Only a lead with destination permission may approve a supported outbound action.

## Complete product journeys

1. **Plan and deliver.** Create a restricted project, import a brief, review unresolved owners and dates, approve tasks and dependency edges together, then maintain them in list, board or graph view.
2. **React to a delay.** Link a chat report to a task. Calculate downstream impact and slack. Compare alternatives, inspect citations and approve a revision. A late task with slack can leave the milestone on time.
3. **Preserve a decision.** Attach a calendar event, submit authorized audio or a transcript, correct speakers, review actions, confirm a decision and trace completed work back to its original passage.
4. **Catch up across tools.** Connect selected GitHub repositories, calendars and individually shared Gmail messages. Search permission-filtered work, inspect opposing evidence, and open source citations.
5. **Run a team.** Use the personal inbox, reminders, weekly health, duplicate suggestions, review queue and audit history. Reopening, archiving, loss of access and connector outages all have visible outcomes.

## Destinations

Workspace home, projects, search, inbox, reviews and settings share one shell. Each project exposes overview, work, dependency graph, documents, meetings and activity. The decision register links from documents and meetings. Risk, task, source and execution detail have stable deep links; a shared URL still checks access.

## Release evidence

Aim for at least 100,000 distinct indexed source objects in one workspace plus nine populated neighboring tenants, ranked search p95 under one second, zero unauthorized reads or writes in isolation tests and a reconcilable audit record for every agent operation. Benchmarks are targets until measured. The [release prompt](feature-specs/22-release-evidence.md) defines the workload and reporting.

Scheduling v1 uses finish-to-start edges within a project, its workweek and explicit nonworking dates. Cross-project references carry evidence. Resource allocation remains a human planning decision. Audio comes from an authorized upload or pasted transcript. The supported external agent write in v1 is a reviewed GitHub issue or PR comment.
