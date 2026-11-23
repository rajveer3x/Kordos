import {
  briefQueue,
  briefWorkerJobSchema,
  idSchema,
  personSchema,
  timeZoneSchema,
  type BriefWorkerJob,
} from "@kordos/contracts";
import { connectBriefWorker } from "@kordos/db";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { extractBrief } from "./brief-model.js";

const sourceSchema = z.object({
  leaseId: idSchema,
  title: z.string(),
  content: z.string(),
  timeZone: timeZoneSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  sourceRevision: z.number().int().positive(),
  owners: z.array(personSchema),
});

export function startBriefs(
  databaseUrl: string,
  model: Parameters<typeof extractBrief>[0],
  producer: Redis,
  consumer: Redis,
  reportRedisError: (error: Error) => void,
) {
  const db = connectBriefWorker(databaseUrl);
  const queue = new Queue<BriefWorkerJob>(briefQueue, {
    connection: producer,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  const worker = new Worker<BriefWorkerJob>(
    briefQueue,
    async (job) => {
      const command = briefWorkerJobSchema.parse(job.data);
      const claimed = await db.claim(command);
      if (!claimed) return;
      const source = sourceSchema.parse(claimed);
      await db.finish(
        command.id,
        source.leaseId,
        await extractBrief(model, source),
      );
    },
    { connection: consumer, concurrency: 2 },
  );
  queue.on("error", reportRedisError);
  worker.on("error", reportRedisError);
  worker.on("failed", (job) => {
    console.error(`[worker] Could not process brief ${job?.id ?? "unknown"}.`);
  });
  return {
    async dispatch(signal: AbortSignal) {
      const pending = await db.pending();
      if (!signal.aborted && pending.length) {
        await queue.addBulk(
          pending.map((entry) => ({
            name: "extract",
            data: entry,
            opts: { jobId: `${entry.id}-${entry.attempt}` },
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
