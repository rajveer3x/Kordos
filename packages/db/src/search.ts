import { randomUUID } from "node:crypto";
import {
  searchResponseSchema,
  searchResultSchema,
  type SearchQuery,
} from "@kordos/contracts";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import { databaseScope } from "./identity.js";

const searchCandidates = searchResponseSchema.extend({
  items: z.array(searchResultSchema.extend({ modelAllowed: z.boolean() })),
});

export function searchStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    canSearch: (actor: string, workspace: string, project?: string) =>
      scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ allowed: boolean }[]>`
          SELECT kordos_identity.current_role() IS NOT NULL AND
            (${project ?? null}::uuid IS NULL OR EXISTS (
              SELECT FROM public.projects WHERE id = ${project ?? null} AND archived_at IS NULL
            )) AS allowed
        `;
        return row?.allowed ?? false;
      }),
    query: (
      actor: string,
      workspace: string,
      input: SearchQuery,
      exact: string | undefined,
      vector?: { model: string; values: number[] },
    ) =>
      scoped(actor, workspace, async (sql) => {
        const [row] = await sql`
        SELECT kordos_search.query(
          ${JSON.stringify(input)}::text::jsonb, ${exact ?? null}, ${vector?.model ?? null},
          ${vector ? JSON.stringify(vector.values) : null}::public.vector
        ) AS value
      `;
        if (row?.value) return searchCandidates.parse(row.value);
      }),
    owners: (actor: string, workspace: string) =>
      scoped(actor, workspace, async (sql) => {
        const [row] = await sql`SELECT kordos_search.owners() AS value`;
        return row?.value as unknown;
      }),
  };
}

export function connectSearchWorker(url: string) {
  const sql = postgres(url, {
    max: 2,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  return {
    async rebuild() {
      const [row] = await sql<{ count: number }[]>`
        SELECT kordos_search.rebuild() AS count
      `;
      return row?.count ?? 0;
    },
    async claim(model: string) {
      const lease = randomUUID();
      const chunks = await sql<
        { id: string; title: string; passage: string }[]
      >`
        SELECT id, title, passage FROM kordos_search.claim_embeddings(${model}, ${lease})
      `;
      return { lease, chunks };
    },
    async finish(
      model: string,
      lease: string,
      values: { id: string; embedding: number[] }[],
    ) {
      await sql`
        SELECT kordos_search.finish_embedding(
          (value->>'id')::uuid, ${lease}, ${model}, (value->>'embedding')::public.vector
        )
        FROM jsonb_array_elements(${JSON.stringify(values)}::text::jsonb)
      `;
    },
    close: () => sql.end({ timeout: 3 }),
  };
}
