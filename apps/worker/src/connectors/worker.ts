import {
  approvalJobSchema,
  type ApprovalJob,
  connectorQueue,
  connectorQueueJobSchema,
  type ConnectorQueueJob,
  type GoogleSettings,
} from "@kordos/contracts";
import {
  connectConnectorWorker,
  openConnectorCredential,
  type ConnectorBatch,
} from "@kordos/db";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { observeQueue } from "../operations.js";
import { ConnectorFailure, fixtureAdapter, syncConnector } from "./adapter.js";
import { githubAdapter, githubFailure, type GitHubSettings } from "./github.js";
import { syncGoogle } from "./google.js";
import { publishGitHubComment } from "./github-comments.js";

export function startConnectors(
  databaseUrl: string,
  settings: {
    fixture?: { key: string; endpoint: string };
    github?: GitHubSettings;
    google?: GoogleSettings;
    publish: boolean;
  },
  producer: Redis,
  consumer: Redis,
  reportRedisError: (error: Error) => void,
) {
  const db = connectConnectorWorker(databaseUrl);
  const { fixture, google } = settings;
  const adapter = fixture ? fixtureAdapter(fixture.endpoint) : undefined;
  const github = settings.github ? githubAdapter(settings.github) : undefined;
  const publication = settings.publish ? github : undefined;
  const outbound = publication
    ? new Queue<ApprovalJob>("kordos-github-comments", {
        connection: producer,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
      })
    : undefined;
  const publisher = publication
    ? new Worker<ApprovalJob>(
        "kordos-github-comments",
        async ({ data }) =>
          publishGitHubComment(
            approvalJobSchema.parse(data).id,
            db,
            publication,
          ),
        { connection: consumer, concurrency: 2 },
      )
    : undefined;
  outbound?.on("error", reportRedisError);
  publisher?.on("error", reportRedisError);
  if (publisher) observeQueue(publisher);
  const queue = new Queue<ConnectorQueueJob>(connectorQueue, {
    connection: producer,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  const worker = new Worker<ConnectorQueueJob>(
    connectorQueue,
    async (message) => {
      const input = connectorQueueJobSchema.parse(message.data);
      const job = await db.claim(input);
      if (!job) return;
      if (job.kind === "cleanup") {
        await db.finish(input.id, job.lease, null, null);
        return;
      }

      const started = performance.now();
      const report = (outcome: string) =>
        console.info(
          JSON.stringify({
            event: "provider.connector",
            operation: job.kind,
            operationId: input.id,
            workspaceId: job.workspaceId,
            provider: job.provider,
            outcome,
            durationMs: Math.round(performance.now() - started),
          }),
        );
      let batch: ConnectorBatch;
      try {
        if (job.provider === "github") {
          if (!github || !job.githubInstallation)
            throw new ConnectorFailure("credential_revoked");
          const repo = await github.connect(
            job.workspaceId,
            job.githubInstallation,
            job.scope,
          );
          if (job.kind === "delivery") {
            if (!job.githubDelivery)
              throw new ConnectorFailure("invalid_batch");
            batch = {
              audience: repo.audience,
              repositoryId: repo.repositoryId,
              changes: await repo.delivery(job.githubDelivery),
              checkpoint: null,
              rebuild: false,
            };
          } else {
            batch = {
              audience: repo.audience,
              ...(await repo.sync(job.checkpoint)),
            };
          }
        } else if (job.provider === "calendar" || job.provider === "gmail") {
          if (!google || !job.credential)
            throw new ConnectorFailure("credential_revoked");
          if (job.kind !== "sync") throw new ConnectorFailure("invalid_batch");
          let refresh: string;
          try {
            refresh = openConnectorCredential(
              google.key,
              job.workspaceId,
              job.installationId,
              job.credential,
            );
          } catch {
            throw new ConnectorFailure("credential_revoked");
          }
          batch = await syncGoogle(
            google,
            job.provider,
            refresh,
            job.scope,
            job.checkpoint,
          );
        } else {
          if (!adapter || !fixture || !job.credential)
            throw new ConnectorFailure("credential_revoked");
          let token: string;
          try {
            token = openConnectorCredential(
              fixture.key,
              job.workspaceId,
              job.installationId,
              job.credential,
            );
          } catch {
            throw new ConnectorFailure("credential_revoked");
          }
          const audience = await adapter.entitlement(token, job.scope);
          if (job.kind === "delivery") {
            if (job.delivery?.scope !== job.scope)
              throw new ConnectorFailure("invalid_batch");
            batch = {
              audience,
              changes: adapter.normalize(job.delivery.changes),
              checkpoint: null,
              rebuild: false,
            };
          } else {
            const result = await syncConnector(
              adapter,
              token,
              job.scope,
              job.checkpoint,
            );
            batch = {
              ...result,
              audience,
              changes: adapter.normalize(result.changes),
            };
          }
        }
      } catch (error) {
        const issue =
          job.provider === "github"
            ? githubFailure(error).issue
            : error instanceof ConnectorFailure
              ? error.issue
              : "invalid_batch";
        report(issue);
        await db.finish(input.id, job.lease, null, issue);
        return;
      }
      report("ok");

      try {
        await db.finish(input.id, job.lease, batch, null);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "22023"
        ) {
          await db.finish(input.id, job.lease, null, "invalid_batch");
          return;
        }
        throw error;
      }
    },
    { connection: consumer, concurrency: 4 },
  );
  queue.on("error", reportRedisError);
  worker.on("error", reportRedisError);
  observeQueue(worker);

  return {
    async dispatch(signal: AbortSignal) {
      const [pending, comments] = await Promise.all([
        db.pending(),
        outbound ? db.githubPending() : [],
      ]);
      if (outbound && comments.length && !signal.aborted) {
        await outbound.addBulk(
          comments.map(({ id }) => ({
            name: "publish",
            data: { id },
            opts: { jobId: id },
          })),
        );
      }
      if (pending.length && !signal.aborted) {
        await queue.addBulk(
          pending.map((job) => ({
            name: "ingest",
            data: job,
            opts: { jobId: `${job.id}-${job.generation}` },
          })),
        );
      }
    },
    async close() {
      await worker.close(consumer.status !== "ready");
      await publisher?.close(consumer.status !== "ready");
      await outbound?.close();
      await queue.close();
      await db.close();
    },
  };
}
