import { setTimeout as delay } from "node:timers/promises";
import { connectRetentionWorker } from "@kordos/db";

export async function runRetention(url: string, signal: AbortSignal) {
  const db = connectRetentionWorker(url);
  let failing = false;
  try {
    while (!signal.aborted) {
      try {
        await db.purge();
        failing = false;
      } catch (error) {
        if (!failing) {
          const code =
            error instanceof Error && "code" in error ? error.code : undefined;
          console.error("[worker] Workspace retention sweep will retry.", code);
        }
        failing = true;
      }
      await delay(1000, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    }
  } finally {
    await db.close();
  }
}
