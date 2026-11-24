import postgres from "postgres";

export function connectOperations(url: string) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  return {
    backlog: () => sql<
      {
        queue: string;
        pending: string;
        oldestAgeSeconds: string;
        retries: string;
      }[]
    >`SELECT queue, pending, oldest_age_seconds AS "oldestAgeSeconds", retries
      FROM kordos_ops.backlog()`,
    close: () => sql.end({ timeout: 3 }),
  };
}
