import {
  approvalJobSchema,
  approvalQueue,
  type ApprovalJob,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

const attempts = 4;

export function startApprovals(
  db: ReturnType<typeof connectDatabase>["reviews"],
  producer: Redis,
  consumer: Redis,
  reportRedisError: (error: Error) => void,
) {
  const queue = new Queue<ApprovalJob>(approvalQueue, {
    connection: producer,
    defaultJobOptions: {
      attempts,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  const worker = new Worker<ApprovalJob>(
    approvalQueue,
    async (job) => {
      const { id } = approvalJobSchema.parse(job.data);
      try {
        if (await db.run(id, "claim")) await db.run(id, "apply");
      } catch (error) {
        if (job.attemptsMade + 1 < attempts) throw error;
        // An uncertain database response may have committed. The database checks
        // the receipt under the same lock before recording a failure.
        await db.run(id, "fail");
      }
    },
    { connection: consumer },
  );
  queue.on("error", reportRedisError);
  worker.on("error", reportRedisError);
  worker.on("failed", (job) => {
    console.error(
      `[worker] Could not process approval ${job?.id ?? "unknown"}.`,
    );
  });
  return {
    async dispatch(signal: AbortSignal) {
      const pending = await db.pending();
      if (!signal.aborted && pending.length) {
        await queue.addBulk(
          pending.map(({ id }) => ({
            name: "apply",
            data: { id },
            opts: { jobId: id },
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
