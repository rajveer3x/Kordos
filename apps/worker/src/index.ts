import { setTimeout as delay } from "node:timers/promises";
import {
  foundationJobKind,
  foundationQueue,
  type FoundationJobPayload,
} from "@kordos/contracts";
import { connectDatabase, databaseUrlSchema } from "@kordos/db";
import { runFoundationJob } from "@kordos/domain";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";

const config = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  })
  .safeParse(process.env);

if (!config.success) {
  const fields = config.error.issues
    .map((issue) => issue.path.join("."))
    .join(", ");
  throw new Error(`Invalid worker environment variables: ${fields}`);
}

const db = connectDatabase(config.data.DATABASE_URL);
const producer = new Redis(config.data.REDIS_URL, {
  connectTimeout: 1500,
  commandTimeout: 1500,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
});
const consumer = new Redis(config.data.REDIS_URL, {
  connectTimeout: 1500,
  maxRetriesPerRequest: null,
});
const queue = new Queue<FoundationJobPayload>(foundationQueue, {
  connection: producer,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

let redisUnavailable = false;
function reportRedisError(error: Error) {
  if (redisUnavailable) return;
  redisUnavailable = true;
  console.error(
    "[worker] Redis connection failed. Waiting to reconnect.",
    error.message,
  );
}
producer.on("error", reportRedisError);
consumer.on("error", reportRedisError);
queue.on("error", reportRedisError);

const worker = new Worker<FoundationJobPayload>(
  foundationQueue,
  async (job) => {
    const { id, effect } = runFoundationJob(job.data);
    const applied = await db.recordEffect(id, effect);
    if (applied) console.info(`[worker] Recorded synthetic effect for ${id}.`);
  },
  { connection: consumer },
);

worker.on("error", reportRedisError);
worker.on("ready", () => {
  redisUnavailable = false;
  console.info("[worker] Ready to process foundation jobs.");
});
worker.on("failed", (job, error) => {
  console.error(
    `[worker] Processing failed for job ${job?.id ?? "unknown"}.`,
    error.message,
  );
});

const shutdown = new AbortController();

async function dispatchPendingJobs(signal: AbortSignal) {
  let dispatchFailed = false;
  while (!signal.aborted) {
    try {
      if (producer.status === "ready") {
        const pending = await db.pendingJobs();
        if (pending.length > 0 && !signal.aborted) {
          // PostgreSQL retains the request until its effect is committed.
          await queue.addBulk(
            pending.map(({ id }) => ({
              name: foundationJobKind,
              data: { id, kind: foundationJobKind },
              opts: { jobId: id },
            })),
          );
        }
        dispatchFailed = false;
      }
    } catch (error) {
      if (!dispatchFailed && !signal.aborted) {
        console.error(
          "[worker] Could not dispatch pending jobs. Will retry.",
          error,
        );
      }
      dispatchFailed = true;
    }

    await delay(1000, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}

const dispatcher = dispatchPendingJobs(shutdown.signal);

async function stop() {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  try {
    await dispatcher;
    await worker.close(consumer.status !== "ready");
    await queue.close();
    await db.close();
  } catch (error) {
    console.error("[worker] Shutdown failed.", error);
    process.exitCode = 1;
  } finally {
    producer.disconnect();
    consumer.disconnect();
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
