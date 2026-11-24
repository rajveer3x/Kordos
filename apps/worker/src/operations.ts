import { setTimeout as delay } from "node:timers/promises";
import { connectOperations } from "@kordos/db";
import type { Job, Worker } from "bullmq";

export function observeQueue<T extends { id: string }>(worker: Worker<T>) {
  function report(phase: "active" | "completed" | "failed", job?: Job<T>) {
    const started = job?.processedOn;
    console.info(
      JSON.stringify({
        event: "queue.job",
        queue: worker.name,
        phase,
        operationId: job?.data.id,
        jobId: job?.id,
        retryCount: job ? Math.max(0, job.attemptsStarted - 1) : undefined,
        queueAgeMs:
          job && started ? Math.max(0, started - job.timestamp) : undefined,
        durationMs:
          started && phase !== "active"
            ? Math.max(0, Date.now() - started)
            : undefined,
      }),
    );
  }
  worker.on("active", (job) => report("active", job));
  worker.on("completed", (job) => report("completed", job));
  worker.on("failed", (job) => report("failed", job));
}

export async function reportBacklog(url: string, signal: AbortSignal) {
  const db = connectOperations(url);
  try {
    while (!signal.aborted) {
      try {
        const rows = await db.backlog();
        console.info(
          JSON.stringify({
            event: "queue.backlog",
            observedAt: new Date().toISOString(),
            queues: rows.map(
              ({ queue, pending, oldestAgeSeconds, retries }) => ({
                queue,
                pending: Number(pending),
                oldestAgeSeconds: Number(oldestAgeSeconds),
                retries: Number(retries),
              }),
            ),
          }),
        );
      } catch {
        console.error(JSON.stringify({ event: "queue.backlog_unavailable" }));
      }
      await delay(30000, undefined, { signal }).catch(() => {});
    }
  } finally {
    await db.close();
  }
}
