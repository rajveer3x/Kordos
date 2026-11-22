import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseUrlSchema } from "./index.js";

const url = databaseUrlSchema.safeParse(process.env.MIGRATION_DATABASE_URL);
if (!url.success) {
  throw new Error(
    "Set MIGRATION_DATABASE_URL to a PostgreSQL URL before migrating.",
  );
}

const client = postgres(url.data, { max: 1, connect_timeout: 5 });
try {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  console.log("Database migrations are up to date.");
} finally {
  await client.end();
}
