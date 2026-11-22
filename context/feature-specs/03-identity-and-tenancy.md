# 03 · Identity and tenancy

**Prerequisites** — [01](01-workspace-foundation.md), [02](02-interface-foundation.md)

## Implementation prompt

Let a user create, join and switch isolated workspaces using authenticated sessions. Follow the [session workflow](../ai-workflow-rules.md).

Integrate Auth0 OIDC using server-side session handling. Provide workspace creation, scoped role assignment, expiring single-use invitations, acceptance and removal. Protect the last admin. Establish the non-owner runtime database role, row policies, session context and minimal append-only audit infrastructure.

Build workspace picker and membership settings. Scope cache and connections to identity and workspace. Centralize membership checks for future resource types. Seed Alice and Bo in separate workspaces with identically named projects in tests.

## Acceptance checks

- [ ] An invitation accepted concurrently yields exactly one membership. A mismatched recipient cannot redeem it.
- [ ] Switching workspaces never reuses another tenant’s data. A removed member loses access while their history remains attributed.
- [ ] Prove tenant isolation with the app DB role in a reused connection pool.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
