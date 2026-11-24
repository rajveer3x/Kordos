import type {
  CreateInvitation,
  CreateWorkspace,
  SessionIdentity,
  UpdateMember,
  WorkspaceMember,
  WorkspaceProject,
  WorkspaceRole,
  WorkspaceSummary,
} from "@kordos/contracts";
import type { Sql, TransactionSql } from "postgres";

type ProviderIdentity = Omit<SessionIdentity, "id"> & {
  issuer: string;
  subject: string;
};

export async function setDatabaseScope(
  sql: TransactionSql,
  actorId: string,
  workspaceId?: string,
) {
  await sql`SELECT set_config('kordos.actor_id', ${actorId}, true),
    set_config('kordos.workspace_id', ${workspaceId ?? ""}, true)`;
}

export function databaseScope(client: Sql) {
  return function scoped<T>(
    actorId: string,
    workspaceId: string | undefined,
    run: (sql: TransactionSql) => Promise<T>,
  ) {
    return client.begin(async (sql) => {
      await setDatabaseScope(sql, actorId, workspaceId);
      return run(sql);
    });
  };
}

export function identityStore(client: Sql) {
  const scoped = databaseScope(client);

  async function role(sql: TransactionSql) {
    const [result] = await sql<{ role: WorkspaceRole | null }[]>`
      SELECT kordos_identity.current_role() AS role
    `;
    return result?.role ?? null;
  }

  return {
    async recordSignIn(profile: ProviderIdentity) {
      const [row] = await client<{ id: string }[]>`
        SELECT kordos_identity.record_sign_in(
          ${profile.issuer}, ${profile.subject}, ${profile.name}, ${profile.email}, ${profile.emailVerified}
        ) AS id
      `;
      if (!row) throw new Error("OIDC identity could not be saved.");
      return row.id;
    },
    session(actorId: string) {
      return scoped(actorId, undefined, async (sql) => {
        const [identity] = await sql<SessionIdentity[]>`
          SELECT id, name, email, email_verified AS "emailVerified" FROM public.users WHERE id = ${actorId}
        `;
        return identity;
      });
    },
    workspaces(actorId: string) {
      return scoped(
        actorId,
        undefined,
        (sql) =>
          sql<
            WorkspaceSummary[]
          >`SELECT * FROM kordos_identity.list_workspaces()`,
      );
    },
    createWorkspace(actorId: string, input: CreateWorkspace) {
      return scoped(actorId, undefined, async (sql) => {
        const [row] = await sql<{ created: boolean }[]>`
          SELECT kordos_identity.create_workspace(${input.id}, ${input.name}, ${input.timeZone}) AS created
        `;
        return row?.created ?? false;
      });
    },
    workspace(actorId: string, workspaceId: string) {
      return scoped(actorId, workspaceId, async (sql) => {
        const [workspace] = await sql<
          (WorkspaceSummary & { accessEpoch: string | null })[]
        >`
          SELECT id, name, time_zone AS "timeZone", kordos_identity.current_role() AS role,
            kordos_retention.access_epoch() AS "accessEpoch"
          FROM public.workspaces WHERE id = ${workspaceId}
        `;
        if (!workspace || workspace.accessEpoch === null) return;
        const { accessEpoch, ...summary } = workspace;
        const projects = await sql<WorkspaceProject[]>`
          SELECT id, name, description, visibility, archived_at IS NOT NULL AS archived FROM public.projects
          WHERE workspace_id = ${workspaceId} ORDER BY name, id
        `;
        return { workspace: summary, projects, accessEpoch };
      });
    },
    members(actorId: string, workspaceId: string) {
      return scoped(actorId, workspaceId, async (sql) => {
        if ((await role(sql)) !== "admin") return;
        return sql<WorkspaceMember[]>`
          SELECT u.id, u.name, u.email, m.role, m.version
          FROM public.memberships m JOIN public.users u ON u.id = m.user_id
          WHERE m.workspace_id = ${workspaceId}
            AND kordos_identity.current_role() = 'admin' ORDER BY u.name, u.id
        `;
      });
    },
    createInvitation(
      actorId: string,
      workspaceId: string,
      input: CreateInvitation,
      tokenHash: string,
    ) {
      return scoped(actorId, workspaceId, async (sql) => {
        const [row] = await sql<{ expiresAt: string | null }[]>`
          SELECT kordos_identity.create_invitation(${input.email}, ${input.role}, ${tokenHash}) AS "expiresAt"
        `;
        return row?.expiresAt
          ? new Date(row.expiresAt).toISOString()
          : undefined;
      });
    },
    acceptInvitation(actorId: string, tokenHash: string) {
      return scoped(actorId, undefined, async (sql) => {
        const [row] = await sql<{ workspaceId: string | null }[]>`
          SELECT kordos_identity.accept_invitation(${tokenHash}) AS "workspaceId"
        `;
        return row?.workspaceId;
      });
    },
    updateMember(
      actorId: string,
      workspaceId: string,
      userId: string,
      input: UpdateMember,
    ) {
      return scoped(actorId, workspaceId, async (sql) => {
        const [row] = await sql<
          { result: "updated" | "conflict" | "last_admin" | "unavailable" }[]
        >`
          SELECT kordos_identity.update_member(${userId}, ${input.expectedVersion}, ${input.role}) AS result
        `;
        const result = row?.result ?? "unavailable";
        if (result !== "conflict") return { result };

        const [current] = await sql<
          Pick<WorkspaceMember, "role" | "version">[]
        >`
          SELECT role, version FROM public.memberships
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
        `;
        return { result, current };
      });
    },
  };
}
