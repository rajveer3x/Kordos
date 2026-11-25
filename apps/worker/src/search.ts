import { setTimeout as delay } from "node:timers/promises";
import { connectSearchWorker } from "@kordos/db";
import {
  ModelQuotaError,
  withModelOperation,
  type modelOperations,
  type searchProvider,
} from "@kordos/search-model";

type SearchWorkerDb = Pick<
  ReturnType<typeof connectSearchWorker>,
  "claim" | "finish" | "defer"
>;
type Embeddings = NonNullable<
  NonNullable<ReturnType<typeof searchProvider>>["embeddings"]
>;

export async function processEmbeddingBatch(
  db: SearchWorkerDb,
  embeddings: Embeddings,
  meter: ReturnType<typeof modelOperations>,
  quotaLimitedUntil: Map<string, number>,
  signal: AbortSignal,
) {
  const now = Date.now();
  for (const [workspaceId, until] of quotaLimitedUntil) {
    if (now >= until) quotaLimitedUntil.delete(workspaceId);
  }
  const { chunks, lease } = await db.claim(embeddings.model, [
    ...quotaLimitedUntil.keys(),
  ]);
  if (chunks.length === 0 || signal.aborted) return false;

  const groups = new Map<string, (typeof chunks)[number][]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.workspaceId);
    if (group) group.push(chunk);
    else groups.set(chunk.workspaceId, [chunk]);
  }
  const entries = Array.from(groups.entries());
  const results = await Promise.allSettled(
    entries.map(async ([workspaceId, batch]) => {
      const values = await withModelOperation(
        meter,
        {
          workspaceId,
          operationId: lease,
        },
        "index_embedding",
        () =>
          embeddings.embed(
            batch.map(({ title, passage }) => title + "\n" + passage),
          ),
      );
      await db.finish(
        embeddings.model,
        lease,
        batch.map(({ id }, index) => ({
          id,
          embedding: values[index]!,
        })),
      );
    }),
  );

  let succeeded = 0;
  let transientFailure = false;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      succeeded++;
      continue;
    }
    const workspaceId = entries[index]![0];
    if (result.reason instanceof ModelQuotaError) {
      if (result.reason.outcome === "limited") {
        quotaLimitedUntil.set(
          workspaceId,
          Date.now() + result.reason.retryAfterSeconds * 1000,
        );
      } else {
        transientFailure = true;
      }
      await db
        .defer(
          lease,
          workspaceId,
          embeddings.model,
          result.reason.retryAfterSeconds,
        )
        .catch(() => {});
    } else {
      transientFailure = true;
    }
  }
  if (transientFailure && succeeded === 0)
    throw new Error("One or more embedding batches will retry.");
  return true;
}

export function startSearch(
  url: string,
  provider: ReturnType<typeof searchProvider>,
  signal: AbortSignal,
  meter: ReturnType<typeof modelOperations>,
) {
  const db = connectSearchWorker(url);
  async function repeat(label: string, process: () => Promise<boolean>) {
    let failing = false;
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await process();
        failing = false;
      } catch (error) {
        if (!failing && !signal.aborted)
          console.error(
            `[worker] Search ${label} failed. Will retry.`,
            error instanceof Error ? error.name : "Unknown error",
          );
        failing = true;
      }
      if (!worked && !signal.aborted)
        await delay(failing ? 5000 : 1000, undefined, { signal }).catch(
          () => {},
        );
    }
  }

  const embeddings = provider?.embeddings;
  const quotaLimitedUntil = new Map<string, number>();
  const indexing = repeat("indexing", async () => (await db.rebuild()) > 0);
  const embedding =
    embeddings &&
    repeat("embedding", () =>
      processEmbeddingBatch(db, embeddings, meter, quotaLimitedUntil, signal),
    );
  return Promise.all([indexing, embedding]).finally(() => db.close());
}
