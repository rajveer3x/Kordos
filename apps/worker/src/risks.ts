import { riskJobSchema, riskQueue, type RiskJob } from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { observeQueue } from "./operations.js";

export function startRisks(
  db: ReturnType<typeof connectDatabase>["risks"],
  producer: Redis,
  consumer: Redis,
  reportRedisError: (error: Error) => void,
) {
  const queue = new Queue<RiskJob>(riskQueue, {
    connection: producer,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  const worker = new Worker<RiskJob>(
    riskQueue,
    (job) => db.process(riskJobSchema.parse(job.data)),
    {
      connection: consumer,
      concurrency: 2,
    },
  );
  queue.on("error", reportRedisError);
  worker.on("error", reportRedisError);
  observeQueue(worker);
  return {
    async dispatch(signal: AbortSignal) {
      const jobs = await db.pending();
      if (!signal.aborted && jobs.length) {
        await queue.addBulk(
          jobs.map((job) => ({
            name: "assess",
            data: job,
            opts: { jobId: job.id },
          })),
        );
      }
    },
    async close() {
      await worker.close(consumer.status !== "ready");
      await queue.close();
    },
  };
}
