# 01 · Workspace foundation

**Prerequisites** — None. Start from the documented product and the current repository.

## Implementation prompt

Give contributors a reproducible local development environment and a working browser-to-database request. Follow the [session workflow](../ai-workflow-rules.md).

Set up the pnpm workspace, web, API, worker and shared packages from architecture-context.md. Add local PostgreSQL with pgvector, Redis and a private storage emulator. Validate configuration on start. Supply example variable names and synthetic development values.

Expose API liveness and readiness separately. Run a durable test job through the worker using a harmless synthetic payload. Add migrations and lockfile, CI type checks, lint and test scripts, and concise local start instructions.

## Acceptance checks

- [x] A clean checkout can install from lockfile, migrate, start the three processes and open the browser health view.
- [x] Stop Redis and observe a useful worker error and degraded readiness. Restart it and complete the same job without duplicate effects.
- [x] Record the commands actually run and their results.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
