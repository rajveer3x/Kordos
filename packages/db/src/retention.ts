import type { UpdateRetention } from "@kordos/contracts";
import postgres, { type Sql } from "postgres";
import { databaseScope } from "./identity.js";

export function retentionStore(client: Sql) {
  const scoped = databaseScope(client);

  return {
    read: (actor: string, workspace: string) =>
      scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ value: unknown }[]>`
          SELECT kordos_retention.read() AS value
        `;
        return row?.value;
      }),
    save: (actor: string, workspace: string, input: UpdateRetention) =>
      scoped(actor, workspace, async (sql) => {
        const [row] = await sql<{ result: "saved" | "conflict" | null }[]>`
          SELECT kordos_retention.save(${JSON.stringify(input)}::text::jsonb) AS result
        `;
        return row?.result;
      }),
  };
}

export function connectRetentionWorker(url: string) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  return {
    async purge() {
      await sql`SELECT kordos_retention.purge()`;
    },
    close: () => sql.end({ timeout: 3 }),
  };
}
