# Using this context in a coding session

Read [product](project-overview.md), [architecture](architecture-context.md), [UI](ui-context.md), [standards](code-standards.md), this file and the [tracker](progress-tracker.md) when starting a feature in a fresh session. Open the chosen feature prompt. Use the final Word specification when a product detail needs more context. User-approved changes take precedence; synchronize the affected files.

## Start a feature

> Start feature 01.

The [root instructions](../AGENTS.md) apply the context and tracker workflow automatically. A feature number selects its spec. “Continue” resumes active work or selects the lowest-numbered ready feature. Dependency numbers refer to the tracker. Record work as Active when implementation actually starts.

## Deliver and hand off

1. Inspect the existing entry points, data and tests. Establish which acceptance case demonstrates the intended user outcome.
2. Implement a complete path through UI, contracts, permissions and persistence wherever applicable. Provide useful progress, empty, denied and recoverable failure states.
3. Run focused verification against the real entry point. Keep deterministic fixture results separate from live provider observations. If a prerequisite is missing, name it and preserve useful verified work.
4. Update the tracker with result, evidence, any remaining gap and the next ready item. Mark done only when the feature’s acceptance checks pass. Record a changed product decision in its owning context file so later prompts inherit it.
5. Use synthetic tenants and provider test accounts for development. A feature prompt authorizes implementation in the repository. A production deployment, provider purchase or outbound message needs its own user authorization.

## Update discipline

Keep scope in the overview, boundaries in architecture, component decisions in UI context, coding conventions in standards, per-feature detail in the spec and actual status in the tracker. For a new feature, describe its outcome, prerequisites, interfaces, failure behavior and observable acceptance cases. Link it into the tracker. If a change supersedes an earlier decision, say which behavior now applies and update dependent prompts.
