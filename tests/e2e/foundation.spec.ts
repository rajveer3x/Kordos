import { execFileSync } from "node:child_process";
import {
  foundationJobIdSchema,
  foundationJobKind,
  foundationQueue,
} from "@kordos/contracts";
import { expect, test } from "@playwright/test";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

function compose(...args: string[]) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    timeout: 20_000,
  }).trim();
}

test("workspace health and job delivery recover after a Redis outage", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Workspace health" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Ready$/ }),
  ).toBeVisible();
  await expect(page.getByText("Available", { exact: true })).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );

  const privateBucket = await request.head(
    `${process.env.STORAGE_ENDPOINT}/${process.env.STORAGE_BUCKET}`,
  );
  expect(privateBucket.status()).toBe(403);

  const runJob = page.getByRole("button", { name: "Run test job" });
  await runJob.click();
  await expect(
    page.getByText("Completed. Result recorded in PostgreSQL."),
  ).toBeVisible();

  try {
    compose("stop", "redis");
    await expect(
      page.getByRole("status").filter({ hasText: /^Degraded$/ }),
    ).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toHaveCount(2);
    const readiness = await request.get("/api/health/ready");
    expect(readiness.status()).toBe(503);
    expect(await readiness.json()).toMatchObject({
      status: "degraded",
      checks: { postgres: "up", redis: "down", storage: "up" },
    });
    const liveness = await request.get("/api/health/live");
    expect(liveness.ok()).toBe(true);
    expect(await liveness.json()).toEqual({ status: "alive" });

    await runJob.click();
    await expect(
      page.getByText("Pending. Waiting for the worker."),
    ).toBeVisible();
    const id = foundationJobIdSchema.parse(
      new URL(page.url()).searchParams.get("job"),
    );
    expect(
      await (await request.get(`/api/foundation/jobs/${id}`)).json(),
    ).toEqual({
      id,
      status: "pending",
    });

    await page.reload();
    await expect(
      page.getByText("Pending. Waiting for the worker."),
    ).toBeVisible();
    compose("start", "redis");

    await expect(
      page.getByRole("status").filter({ hasText: /^Ready$/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Completed. Result recorded in PostgreSQL."),
    ).toBeVisible();
    const completed = await (
      await request.get(`/api/foundation/jobs/${id}`)
    ).json();
    expect(completed).toMatchObject({
      id,
      status: "completed",
      effect: "synthetic-job-processed",
    });

    const retry = await request.post("/api/foundation/jobs", { data: { id } });
    expect(retry.status()).toBe(202);
    expect(await retry.json()).toEqual(completed);

    // Use a different BullMQ ID to force an actual redelivery of the same durable job.
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl)
      throw new Error("Set REDIS_URL before running the browser test.");
    const redis = new Redis(redisUrl);
    const queue = new Queue(foundationQueue, { connection: redis });
    try {
      const replay = await queue.add(
        foundationJobKind,
        { id, kind: foundationJobKind },
        { jobId: `${id}-replay`, removeOnComplete: false },
      );
      await expect.poll(() => replay.getState()).toBe("completed");
      await replay.remove();
    } finally {
      await queue.close();
      redis.disconnect();
    }
    expect(
      await (await request.get(`/api/foundation/jobs/${id}`)).json(),
    ).toEqual(completed);

    const receipts = compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-XAt",
      "-U",
      process.env.POSTGRES_USER ?? "kordos_migrator",
      "-d",
      process.env.POSTGRES_DB ?? "kordos",
      "-c",
      `SELECT count(*) FROM foundation_job_effects WHERE job_id = '${id}';`,
    );
    expect(receipts).toBe("1");
  } finally {
    compose("start", "redis");
  }
});
