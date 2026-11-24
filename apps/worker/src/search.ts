import { setTimeout as delay } from "node:timers/promises";
import { connectSearchWorker } from "@kordos/db";
import {
  withModelOperation,
  type modelOperations,
  type searchProvider,
} from "@kordos/search-model";

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
  const indexing = repeat("indexing", async () => (await db.rebuild()) > 0);
  const embedding =
    embeddings &&
    repeat("embedding", async () => {
      const { chunks, lease } = await db.claim(embeddings.model);
      if (chunks.length === 0 || signal.aborted) return false;
      const groups = new Map<string, (typeof chunks)[number][]>();
      for (const chunk of chunks) {
        const group = groups.get(chunk.workspaceId);
        if (group) group.push(chunk);
        else groups.set(chunk.workspaceId, [chunk]);
      }
      const results = await Promise.allSettled(
        Array.from(groups, async ([workspaceId, batch]) => {
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
      if (results.some(({ status }) => status === "rejected"))
        throw new Error("One or more embedding batches will retry.");
      return true;
    });
  return Promise.all([indexing, embedding]).finally(() => db.close());
}
