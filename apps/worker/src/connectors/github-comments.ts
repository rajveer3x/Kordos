import type { connectConnectorWorker } from "@kordos/db";
import { githubFailure, githubRefused, type GitHubAdapter } from "./github.js";

export async function publishGitHubComment(
  id: string,
  db: ReturnType<typeof connectConnectorWorker>,
  adapter: GitHubAdapter,
) {
  const job = await db.githubClaim(id);
  if (!job) return;
  const {
    workspaceId,
    installationId,
    command: { destination, body },
    started,
    lease,
  } = job;
  const update = (step: "start" | "retry" | "refuse") =>
    db.githubExecute(id, step, lease);
  const repo = await adapter
    .connect(
      workspaceId,
      installationId,
      destination.repository,
      started ? undefined : destination,
    )
    .catch(async (error: unknown) => {
      const { issue } = githubFailure(error);
      await update(
        !started && ["scope_unavailable", "credential_revoked"].includes(issue)
          ? "refuse"
          : "retry",
      );
      return null;
    });
  if (!repo) return;
  if (repo.repositoryId !== destination.repositoryId) {
    await update(started ? "retry" : "refuse");
    return;
  }
  if (started) {
    const remote = await repo.reconcile(destination, body).catch(() => null);
    if (remote) await db.githubExecute(id, "complete", lease, remote);
    else await update("retry");
    return;
  }
  try {
    await repo.check(destination);
  } catch (error) {
    const { issue } = githubFailure(error);
    await update(
      ["scope_unavailable", "credential_revoked"].includes(issue)
        ? "refuse"
        : "retry",
    );
    return;
  }
  if (
    !(await db.githubExecute(id, "start", lease, { audience: repo.audience }))
  )
    return;
  const remote = await repo
    .publish(destination, body)
    .catch(async (error: unknown) => {
      await update(githubRefused(error) ? "refuse" : "retry");
      return null;
    });
  if (remote) await db.githubExecute(id, "complete", lease, remote);
}
