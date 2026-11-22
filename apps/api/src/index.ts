import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  foundationJobIdSchema,
  foundationJobRequestSchema,
  type Readiness,
} from "@kordos/contracts";
import { connectDatabase } from "@kordos/db";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { registerIdentity } from "./identity/routes.js";

const config = loadConfig(process.env);
const app = Fastify({
  logger: true,
  logController: new Fastify.LogController({ disableRequestLogging: true }),
});
const db = connectDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, {
  connectTimeout: 1500,
  commandTimeout: 1500,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
});
const storage = new S3Client({
  endpoint: config.STORAGE_ENDPOINT,
  region: config.STORAGE_REGION,
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: {
    accessKeyId: config.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
  },
});

// Redis reconnects automatically. Readiness reports connection failures.
redis.on("error", () => {});

app.get("/api/health/live", async () => ({ status: "alive" }));
app.get("/api/health/ready", async (_request, reply) => {
  const [postgres, queue, bucket] = await Promise.allSettled([
    db.checkReady(),
    redis.ping(),
    storage.send(new HeadBucketCommand({ Bucket: config.STORAGE_BUCKET }), {
      abortSignal: AbortSignal.timeout(1500),
    }),
  ]);
  const checks: Readiness["checks"] = {
    postgres: postgres.status === "fulfilled" ? "up" : "down",
    redis: queue.status === "fulfilled" ? "up" : "down",
    storage: bucket.status === "fulfilled" ? "up" : "down",
  };
  const ready = Object.values(checks).every((status) => status === "up");
  const body: Readiness = { status: ready ? "ready" : "degraded", checks };
  return reply
    .code(ready ? 200 : 503)
    .header("Cache-Control", "no-store")
    .send(body);
});

if (config.ENABLE_FOUNDATION_JOBS) {
  app.post("/api/foundation/jobs", async (request, reply) => {
    const input = foundationJobRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ message: "Provide a valid job ID." });
    }

    try {
      const job = await db.createJob(input.data.id);
      if (job) {
        return reply
          .code(202)
          .header("Location", `/api/foundation/jobs/${job.id}`)
          .header("Cache-Control", "no-store")
          .send(job);
      }
    } catch (error) {
      request.log.error({ err: error }, "Could not persist the foundation job");
    }
    return reply
      .code(503)
      .send({ message: "The job store is unavailable. Try again." });
  });

  app.get<{ Params: { id: string } }>(
    "/api/foundation/jobs/:id",
    async (request, reply) => {
      const id = foundationJobIdSchema.safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ message: "Provide a valid job ID." });
      }

      try {
        const job = await db.readJob(id.data);
        if (job) return reply.header("Cache-Control", "no-store").send(job);
        return reply.code(404).send({ message: "The test job was not found." });
      } catch (error) {
        request.log.error({ err: error }, "Could not read the foundation job");
        return reply
          .code(503)
          .send({ message: "The job store is unavailable. Try again." });
      }
    },
  );
}

registerIdentity(app, config, redis, db);

app.addHook("onClose", async () => {
  redis.disconnect();
  storage.destroy();
  await db.close();
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "API shutdown failed");
    process.exitCode = 1;
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await app.listen({ host: "127.0.0.1", port: config.API_PORT });
} catch (error) {
  app.log.error({ err: error }, "API failed to start");
  await stop();
  process.exitCode = 1;
}
