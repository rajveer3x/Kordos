import { S3Client } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";
import {
  foundationJobKind,
  foundationQueue,
  type FoundationJobPayload,
} from "@kordos/contracts";
import {
  connectDatabase,
  connectorKeySchema,
  databaseUrlSchema,
  fixtureEndpointSchema,
} from "@kordos/db";
import { runFoundationJob } from "@kordos/domain";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { startBriefs } from "./briefs.js";
import { startConnectors } from "./connectors/worker.js";
import { startInbox } from "./inbox.js";
import { startMeetings } from "./meetings.js";
import { startRisks } from "./risks.js";
import { startApprovals } from "./approvals.js";

const config = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    BRIEF_WORKER_DATABASE_URL: databaseUrlSchema.optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .default("https://api.openai.com/v1/"),
    OPENAI_MEETING_MODEL: z
      .string()
      .min(1)
      .default("gpt-4o-transcribe-diarize"),
    MEETING_TRANSCRIPTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(115000)
      .default(90000),
    STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    STORAGE_REGION: z.string().min(1).optional(),
    STORAGE_BUCKET: z.string().min(1).optional(),
    STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    OPENAI_BRIEF_MODEL: z.string().min(1).optional(),
    BRIEF_MODEL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(30000)
      .default(12000),
    CONNECTOR_TOKEN_KEY: connectorKeySchema.optional(),
    CONNECTOR_FIXTURE_URL: fixtureEndpointSchema.optional(),
    INBOX_EMAIL_URL: z.url({ protocol: /^https?$/ }).optional(),
    INBOX_EMAIL_KEY: z.string().min(1).optional(),
    INBOX_EMAIL_FROM: z.string().min(1).optional(),
    APP_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
    WEB_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
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

const approvals = startApprovals(
  db.reviews,
  producer,
  consumer,
  reportRedisError,
);
const settings = config.data;
const connectors =
  settings.BRIEF_WORKER_DATABASE_URL &&
  settings.CONNECTOR_TOKEN_KEY &&
  settings.CONNECTOR_FIXTURE_URL
    ? startConnectors(
        settings.BRIEF_WORKER_DATABASE_URL,
        {
          key: settings.CONNECTOR_TOKEN_KEY,
          fixtureEndpoint: settings.CONNECTOR_FIXTURE_URL,
        },
        producer,
        consumer,
        reportRedisError,
      )
    : undefined;
const briefs = settings.BRIEF_WORKER_DATABASE_URL
  ? startBriefs(
      settings.BRIEF_WORKER_DATABASE_URL,
      settings.OPENAI_API_KEY && settings.OPENAI_BRIEF_MODEL
        ? {
            apiKey: settings.OPENAI_API_KEY,
            baseUrl: settings.OPENAI_BASE_URL,
            model: settings.OPENAI_BRIEF_MODEL,
            timeoutMs: settings.BRIEF_MODEL_TIMEOUT_MS,
          }
        : undefined,
      producer,
      consumer,
      reportRedisError,
    )
  : undefined;
const risks = startRisks(db.risks, producer, consumer, reportRedisError);
const storage =
  settings.STORAGE_ENDPOINT &&
  settings.STORAGE_REGION &&
  settings.STORAGE_BUCKET &&
  settings.STORAGE_ACCESS_KEY_ID &&
  settings.STORAGE_SECRET_ACCESS_KEY
    ? {
        bucket: settings.STORAGE_BUCKET,
        client: new S3Client({
          endpoint: settings.STORAGE_ENDPOINT,
          region: settings.STORAGE_REGION,
          forcePathStyle: true,
          maxAttempts: 1,
          credentials: {
            accessKeyId: settings.STORAGE_ACCESS_KEY_ID,
            secretAccessKey: settings.STORAGE_SECRET_ACCESS_KEY,
          },
        }),
      }
    : undefined;
const meetings = settings.BRIEF_WORKER_DATABASE_URL
  ? startMeetings(
      settings.BRIEF_WORKER_DATABASE_URL,
      storage,
      settings.OPENAI_API_KEY
        ? {
            apiKey: settings.OPENAI_API_KEY,
            baseUrl: settings.OPENAI_BASE_URL,
            model: settings.OPENAI_MEETING_MODEL,
            timeoutMs: settings.MEETING_TRANSCRIPTION_TIMEOUT_MS,
          }
        : undefined,
      producer,
      consumer,
      reportRedisError,
    )
  : undefined;
const shutdown = new AbortController();
const inbox = startInbox(
  settings.BRIEF_WORKER_DATABASE_URL ?? settings.DATABASE_URL,
  shutdown.signal,
  settings.BRIEF_WORKER_DATABASE_URL &&
    settings.INBOX_EMAIL_URL &&
    settings.INBOX_EMAIL_KEY &&
    settings.INBOX_EMAIL_FROM
    ? {
        endpoint: settings.INBOX_EMAIL_URL,
        key: settings.INBOX_EMAIL_KEY,
        from: settings.INBOX_EMAIL_FROM,
        origin: settings.APP_ORIGIN ?? `http://127.0.0.1:${settings.WEB_PORT}`,
      }
    : undefined,
);

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
        await approvals.dispatch(signal);
        await risks.dispatch(signal);
        await briefs?.dispatch(signal);
        await meetings?.dispatch(signal);
        await connectors?.dispatch(signal);
        dispatchFailed = false;
      }
    } catch (error) {
      if (!dispatchFailed && !signal.aborted) {
        console.error(
          "[worker] Could not dispatch pending jobs. Will retry.",
          error instanceof Error ? error.name : "Unknown error",
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
    await Promise.all([
      worker.close(consumer.status !== "ready"),
      approvals.close(),
      risks.close(),
      briefs?.close(),
      meetings?.close(),
      connectors?.close(),
      inbox,
    ]);
    await queue.close();
    await db.close();
  } catch (error) {
    console.error("[worker] Shutdown failed.", error);
    process.exitCode = 1;
  } finally {
    storage?.client.destroy();
    producer.disconnect();
    consumer.disconnect();
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
