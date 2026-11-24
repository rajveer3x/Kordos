import { setTimeout as delay } from "node:timers/promises";
import { connectHealthWorker } from "@kordos/db";

export async function runProjectHealth(url: string, signal: AbortSignal) {
  const db = connectHealthWorker(url);
  let failed = false;
  try {
    while (!signal.aborted) {
      try {
        for (let index = 0; index < 10 && !signal.aborted; index++) {
          if (!(await db.captureNext())) break;
        }
        failed = false;
      } catch {
        if (!failed && !signal.aborted) {
          console.error(
            "[worker] Could not refresh weekly health. Will retry.",
          );
        }
        failed = true;
      }
      await delay(5000, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    }
  } finally {
    await db.close();
  }
}
