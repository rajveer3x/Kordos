import { setTimeout as delay } from "node:timers/promises";
import { connectSearchWorker } from "@kordos/db";
import type { searchProvider } from "@kordos/search-model";

export function startSearch(
  url: string,
  provider: ReturnType<typeof searchProvider>,
  signal: AbortSignal,
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
      const values = await embeddings.embed(
        chunks.map(({ title, passage }) => title + "\n" + passage),
      );
      await db.finish(
        embeddings.model,
        lease,
        chunks.map(({ id }, index) => ({
          id,
          embedding: values[index]!,
        })),
      );
      return true;
    });
  return Promise.all([indexing, embedding]).finally(() => db.close());
}
