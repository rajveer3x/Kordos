import {
  connectorQueue,
  connectorQueueJobSchema,
  type ConnectorQueueJob,
} from "@kordos/contracts";
import {
  connectConnectorWorker,
  openConnectorCredential,
  type ConnectorBatch,
} from "@kordos/db";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { ConnectorFailure, fixtureAdapter, syncConnector } from "./adapter.js";

export function startConnectors(
  databaseUrl: string,
  settings: { key: string; fixtureEndpoint: string },
  producer: Redis,
  consumer: Redis,
  reportRedisError: (error: Error) => void,
) {
  const db = connectConnectorWorker(databaseUrl);
  const adapters = { fixture: fixtureAdapter(settings.fixtureEndpoint) };
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

      let token: string;
      try {
        token = openConnectorCredential(
          settings.key,
          job.workspaceId,
          job.installationId,
          job.credential,
        );
      } catch {
        await db.finish(input.id, job.lease, null, "credential_revoked");
        return;
      }
      const adapter = adapters[job.provider];
      let batch: ConnectorBatch;
      try {
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
      } catch (error) {
        await db.finish(
          input.id,
          job.lease,
          null,
          error instanceof ConnectorFailure ? error.issue : "invalid_batch",
        );
        return;
      }

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
  worker.on("failed", (job) => {
    if (job)
      console.error(
        "[worker] Connector job will be recovered from its durable lease.",
        job.id,
      );
  });

  return {
    async dispatch(signal: AbortSignal) {
      const pending = await db.pending();
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
      await queue.close();
      await db.close();
    },
  };
}
