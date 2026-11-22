import { databaseUrlSchema } from "@kordos/db";
import { z } from "zod";

const configSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4301),
  DATABASE_URL: databaseUrlSchema,
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }),
  STORAGE_REGION: z.string().trim().min(1),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  STORAGE_ACCESS_KEY_ID: z.string().trim().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().trim().min(1),
  ENABLE_FOUNDATION_JOBS: z.stringbool().default(false),
});

export function loadConfig(env: NodeJS.ProcessEnv) {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Invalid API environment variables: ${fields}`);
  }
  return result.data;
}
