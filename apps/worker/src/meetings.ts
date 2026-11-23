import {
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  meetingClaimSchema,
  meetingItemsSchema,
  meetingJobSchema,
  meetingQueue,
  meetingTranscriptSchema,
  type MeetingJob,
} from "@kordos/contracts";
import { connectMeetingWorker } from "@kordos/db";
import { extractMeetingItems, splitMeetingText } from "@kordos/domain";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  transcribeMeeting,
  type TranscriptionConfig,
} from "./meeting-transcription.js";

type Storage = { client: S3Client; bucket: string };
type Claim = ReturnType<typeof meetingClaimSchema.parse>;

async function readTranscript(
  claim: Claim,
  storage: Storage | undefined,
  model: TranscriptionConfig | undefined,
) {
  if (claim.mode === "paste")
    return { segments: splitMeetingText(claim.text ?? "") };
  if (claim.mode === "extract") return { segments: claim.transcript };
  if (!claim.audio || !storage)
    return { failure: "media_unavailable" } as const;
  if (!model) return { failure: "provider_unavailable" } as const;
  let bytes: Uint8Array;
  try {
    const media = await storage.client.send(
      new GetObjectCommand({ Bucket: storage.bucket, Key: claim.audio.key }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
    if (!media.Body || media.ContentLength !== claim.audio.size)
      return { failure: "media_unavailable" } as const;
    bytes = await media.Body.transformToByteArray();
    if (bytes.length !== claim.audio.size)
      return { failure: "media_unavailable" } as const;
  } catch {
    return { failure: "media_unavailable" } as const;
  }
  return transcribeMeeting(model, bytes, claim.audio.extension);
}

export function startMeetings(
  url: string,
  storage: Storage | undefined,
  model: TranscriptionConfig | undefined,
  producer: Redis,
  consumer: Redis,
  reportRedisError: (error: Error) => void,
) {
  const db = connectMeetingWorker(url);
  const queue = new Queue<MeetingJob>(meetingQueue, {
    connection: producer,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  const worker = new Worker<MeetingJob>(
    meetingQueue,
    async (job) => {
      const input = meetingJobSchema.parse(job.data);
      const raw = await db.claim(input);
      if (!raw) return;
      const claim = meetingClaimSchema.parse(raw);
      const outcome = await readTranscript(claim, storage, model);
      if ("failure" in outcome && outcome.failure)
        return db.finish(input.id, claim.lease, { failure: outcome.failure });
      const segments = meetingTranscriptSchema.safeParse(outcome.segments);
      if (!segments.success)
        return db.finish(input.id, claim.lease, {
          failure: "invalid_transcript",
        });
      const items = meetingItemsSchema.safeParse(
        extractMeetingItems(
          segments.data,
          claim.revision,
          claim.startsAt,
          claim.timeZone,
          claim.owners,
        ),
      );
      return db.finish(
        input.id,
        claim.lease,
        items.success
          ? { segments: segments.data, items: items.data }
          : { failure: "invalid_transcript" },
      );
    },
    { connection: consumer, concurrency: 2 },
  );
  queue.on("error", reportRedisError);
  worker.on("error", reportRedisError);
  worker.on("failed", (job) =>
    console.error(
      `[worker] Could not process meeting ${job?.id ?? "unknown"}.`,
    ),
  );
  let lastCleanup = 0;
  let cleaning: Promise<void> | undefined;
  return {
    async dispatch(signal: AbortSignal) {
      const jobs = await db.pending();
      if (!signal.aborted && jobs.length)
        await queue.addBulk(
          jobs.map((job) => ({
            name: "process",
            data: job,
            opts: { jobId: `${job.id}-${job.generation}` },
          })),
        );
      if (
        storage &&
        !signal.aborted &&
        !cleaning &&
        Date.now() - lastCleanup >= 5000
      ) {
        lastCleanup = Date.now();
        cleaning = (async () => {
          const due = await db.cleanup();
          await Promise.all(
            due.map(async ({ id, key }) => {
              await storage.client.send(
                new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }),
                { abortSignal: AbortSignal.timeout(15000) },
              );
              await db.cleaned(id);
            }),
          );
        })()
          .catch(() =>
            console.error("[worker] Meeting media cleanup will retry."),
          )
          .finally(() => {
            cleaning = undefined;
          });
      }
    },
    async close() {
      await worker.close(consumer.status !== "ready");
      await cleaning;
      await queue.close();
      await db.close();
    },
  };
}
