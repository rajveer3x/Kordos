import { S3Client } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";
import {
  foundationJobKind,
  foundationQueue,
  githubBindingsSchema,
  googleEndpoints,
  googleOAuthEnv,
  groqModelEnv,
  groqModelSettings,
  githubIdSchema,
  searchModelEnv,
  type FoundationJobPayload,
} from "@kordos/contracts";
import {
  connectDatabase,
  connectorKeySchema,
  databaseUrlSchema,
  fixtureEndpointSchema,
} from "@kordos/db";
import {
  modelOperations,
  modelOperationsEnv,
  searchProvider,
} from "@kordos/search-model";
import { runFoundationJob } from "@kordos/domain";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { startBriefs } from "./briefs.js";
import { startConnectors } from "./connectors/worker.js";
import { startInbox } from "./inbox.js";
import { runRetention } from "./retention.js";
import { startMeetings } from "./meetings.js";
import { startSearch } from "./search.js";
import { runProjectHealth } from "./project-health.js";
import { startRisks } from "./risks.js";
import { startApprovals } from "./approvals.js";
import { observeQueue, reportBacklog } from "./operations.js";

const config = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    BRIEF_WORKER_DATABASE_URL: databaseUrlSchema.optional(),
    ...searchModelEnv,
    ...groqModelEnv,
    ...modelOperationsEnv,
    GROQ_TRANSCRIPTION_MODEL: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .default("whisper-large-v3-turbo"),
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
    ...googleOAuthEnv,
    GOOGLE_FIXTURE_URL: fixtureEndpointSchema.optional(),
    CONNECTOR_TOKEN_KEY: connectorKeySchema.optional(),
    CONNECTOR_FIXTURE_URL: fixtureEndpointSchema.optional(),
    GITHUB_APP_ID: githubIdSchema.optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_INSTALLATIONS: githubBindingsSchema.optional(),
    GITHUB_FIXTURE_URL: fixtureEndpointSchema
      .refine((value) => new URL(value).hostname === "127.0.0.1")
      .optional(),
    INBOX_EMAIL_URL: z.url({ protocol: /^https?$/ }).optional(),
    INBOX_EMAIL_KEY: z.string().min(1).optional(),
    INBOX_EMAIL_FROM: z.string().min(1).optional(),
    APP_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
    WEB_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    ENABLE_EXTERNAL_WRITES: z.stringbool().default(true),
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
    error.name,
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
observeQueue(worker);

const approvals = startApprovals(
  db.reviews,
  producer,
  consumer,
  reportRedisError,
);
const settings = config.data;
const meter = modelOperations(producer, settings);
const groq = groqModelSettings(settings, process.env.NODE_ENV);
const fixture =
  settings.CONNECTOR_TOKEN_KEY && settings.CONNECTOR_FIXTURE_URL
    ? {
        key: settings.CONNECTOR_TOKEN_KEY,
        endpoint: settings.CONNECTOR_FIXTURE_URL,
      }
    : undefined;
const github =
  settings.GITHUB_APP_ID &&
  settings.GITHUB_APP_PRIVATE_KEY &&
  settings.GITHUB_INSTALLATIONS
    ? {
        appId: settings.GITHUB_APP_ID,
        privateKey: settings.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
        endpoint:
          (process.env.NODE_ENV !== "production"
            ? settings.GITHUB_FIXTURE_URL
            : undefined) ?? "https://api.github.com/",
        bindings: settings.GITHUB_INSTALLATIONS,
      }
    : undefined;
const google =
  settings.GOOGLE_CLIENT_ID &&
  settings.GOOGLE_CLIENT_SECRET &&
  settings.CONNECTOR_TOKEN_KEY
    ? {
        clientId: settings.GOOGLE_CLIENT_ID,
        clientSecret: settings.GOOGLE_CLIENT_SECRET,
        key: settings.CONNECTOR_TOKEN_KEY,
        endpoints: googleEndpoints(
          process.env.NODE_ENV !== "production"
            ? settings.GOOGLE_FIXTURE_URL
            : undefined,
        ),
      }
    : undefined;
if ((settings.GOOGLE_CLIENT_ID || settings.GOOGLE_CLIENT_SECRET) && !google)
  throw new Error(
    "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and CONNECTOR_TOKEN_KEY together.",
  );
const connectors =
  settings.BRIEF_WORKER_DATABASE_URL && (fixture || github || google)
    ? startConnectors(
        settings.BRIEF_WORKER_DATABASE_URL,
        { fixture, github, google, publish: settings.ENABLE_EXTERNAL_WRITES },
        producer,
        consumer,
        reportRedisError,
      )
    : undefined;
const briefs = settings.BRIEF_WORKER_DATABASE_URL
  ? startBriefs(
      settings.BRIEF_WORKER_DATABASE_URL,
      groq
        ? { ...groq, timeoutMs: settings.BRIEF_MODEL_TIMEOUT_MS }
        : settings.OPENAI_API_KEY && settings.OPENAI_BRIEF_MODEL
          ? {
              provider: "openai",
              apiKey: settings.OPENAI_API_KEY,
              baseUrl: settings.OPENAI_BASE_URL,
              model: settings.OPENAI_BRIEF_MODEL,
              timeoutMs: settings.BRIEF_MODEL_TIMEOUT_MS,
            }
          : undefined,
      producer,
      consumer,
      reportRedisError,
      meter,
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
      groq
        ? {
            ...groq,
            model: settings.GROQ_TRANSCRIPTION_MODEL,
            timeoutMs: settings.MEETING_TRANSCRIPTION_TIMEOUT_MS,
          }
        : settings.OPENAI_API_KEY
          ? {
              provider: "openai",
              apiKey: settings.OPENAI_API_KEY,
              baseUrl: settings.OPENAI_BASE_URL,
              model: settings.OPENAI_MEETING_MODEL,
              timeoutMs: settings.MEETING_TRANSCRIPTION_TIMEOUT_MS,
            }
          : undefined,
      producer,
      consumer,
      reportRedisError,
      meter,
    )
  : undefined;
const shutdown = new AbortController();
const retention = settings.BRIEF_WORKER_DATABASE_URL
  ? runRetention(settings.BRIEF_WORKER_DATABASE_URL, shutdown.signal)
  : undefined;
const search = settings.BRIEF_WORKER_DATABASE_URL
  ? startSearch(
      settings.BRIEF_WORKER_DATABASE_URL,
      !groq && settings.OPENAI_SEARCH_EMBEDDING_MODEL
        ? searchProvider(settings)
        : undefined,
      shutdown.signal,
      meter,
    )
  : undefined;
const inbox = startInbox(
  settings.BRIEF_WORKER_DATABASE_URL ?? settings.DATABASE_URL,
  shutdown.signal,
  settings.BRIEF_WORKER_DATABASE_URL &&
    settings.ENABLE_EXTERNAL_WRITES &&
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
const backlog = settings.BRIEF_WORKER_DATABASE_URL
  ? reportBacklog(settings.BRIEF_WORKER_DATABASE_URL, shutdown.signal)
  : undefined;
const weeklyHealth = settings.BRIEF_WORKER_DATABASE_URL
  ? runProjectHealth(settings.BRIEF_WORKER_DATABASE_URL, shutdown.signal)
  : undefined;

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
      weeklyHealth,
      search,
      retention,
      backlog,
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
