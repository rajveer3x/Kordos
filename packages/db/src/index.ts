import type { FoundationJob, FoundationJobEffect } from "@kordos/contracts";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { briefsStore } from "./briefs.js";
import { collaborationStore } from "./collaboration.js";
import { forecastStore } from "./forecast.js";
import { identityStore } from "./identity.js";
import { knowledgeStore } from "./knowledge.js";
import { planningStore } from "./planning.js";
import { risksStore } from "./risks.js";
import { reviewsStore } from "./reviews.js";
import { foundationJobEffects, foundationJobs } from "./schema.js";

export { connectBriefWorker } from "./briefs.js";
export { setDatabaseScope } from "./identity.js";

export const databaseUrlSchema = z.url({ protocol: /^(postgres|postgresql)$/ });

export function connectDatabase(url: string) {
  const client = postgres(url, {
    connect_timeout: 2,
    connection: { statement_timeout: 1500 },
  });
  const db = drizzle(client);

  async function readJob(id: string): Promise<FoundationJob | undefined> {
    const [row] = await db
      .select({
        id: foundationJobs.id,
        receipt: {
          effect: foundationJobEffects.effect,
          completedAt: foundationJobEffects.completedAt,
        },
      })
      .from(foundationJobs)
      .leftJoin(
        foundationJobEffects,
        eq(foundationJobs.id, foundationJobEffects.jobId),
      )
      .where(eq(foundationJobs.id, id));

    if (!row) return undefined;

    return row.receipt
      ? {
          id: row.id,
          status: "completed",
          effect: row.receipt.effect,
          completedAt: row.receipt.completedAt.toISOString(),
        }
      : { id: row.id, status: "pending" };
  }

  return {
    briefs: briefsStore(client),
    collaboration: collaborationStore(client),
    knowledge: knowledgeStore(client),
    identity: identityStore(client),
    planning: planningStore(client),
    reviews: reviewsStore(client),
    risks: risksStore(client),
    forecast: forecastStore(client),
    async checkReady() {
      await db.execute(sql`
        SELECT 1 FROM ${foundationJobs}, ${foundationJobEffects}, public.workspaces, public.work_items,
          public.dependency_edges, public.scenarios, public.documents LIMIT 0
      `);
    },
    async createJob(id: string) {
      await db.insert(foundationJobs).values({ id }).onConflictDoNothing();
      return readJob(id);
    },
    readJob,
    async pendingJobs() {
      return db
        .select({ id: foundationJobs.id })
        .from(foundationJobs)
        .leftJoin(
          foundationJobEffects,
          eq(foundationJobs.id, foundationJobEffects.jobId),
        )
        .where(isNull(foundationJobEffects.jobId))
        .orderBy(asc(foundationJobs.createdAt), asc(foundationJobs.id))
        .limit(50);
    },
    async recordEffect(jobId: string, effect: FoundationJobEffect) {
      const receipts = await db
        .insert(foundationJobEffects)
        .values({ jobId, effect })
        .onConflictDoNothing()
        .returning({ jobId: foundationJobEffects.jobId });
      return receipts.length > 0;
    },
    close: () => client.end({ timeout: 3 }),
  };
}
