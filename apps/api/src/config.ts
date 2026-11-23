import {
  connectorKeySchema,
  fixtureEndpointSchema,
  databaseUrlSchema,
} from "@kordos/db";
import { z } from "zod";

const configSchema = z.object({
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  AUTH0_ISSUER: z.url({ protocol: /^https?$/ }).optional(),
  AUTH0_CLIENT_ID: z.string().trim().min(1).optional(),
  AUTH0_CLIENT_SECRET: z.string().min(1).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4301),
  DATABASE_URL: databaseUrlSchema,
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }),
  STORAGE_REGION: z.string().trim().min(1),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  STORAGE_ACCESS_KEY_ID: z.string().trim().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().trim().min(1),
  CONNECTOR_TOKEN_KEY: connectorKeySchema.optional(),
  CONNECTOR_FIXTURE_URL: fixtureEndpointSchema.optional(),
  CONNECTOR_FIXTURE_WEBHOOK_SECRET: z.string().min(32).optional(),
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
  const {
    APP_ORIGIN,
    WEB_PORT,
    AUTH0_ISSUER,
    AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET,
  } = result.data;
  const origin = new URL(APP_ORIGIN ?? `http://127.0.0.1:${WEB_PORT}`);
  const allowedTransport = (url: URL) =>
    url.protocol === "https:" ||
    (env.NODE_ENV !== "production" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  if (origin.href !== origin.origin + "/" || !allowedTransport(origin)) {
    throw new Error(
      "APP_ORIGIN must be an HTTPS origin or a local development origin.",
    );
  }

  if (!AUTH0_ISSUER && !AUTH0_CLIENT_ID && !AUTH0_CLIENT_SECRET) {
    return { ...result.data, origin, auth: undefined };
  }
  if (!AUTH0_ISSUER || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET) {
    throw new Error(
      "Set AUTH0_ISSUER, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET together.",
    );
  }
  const issuer = new URL(AUTH0_ISSUER);
  if (issuer.href !== issuer.origin + "/" || !allowedTransport(issuer)) {
    throw new Error(
      "AUTH0_ISSUER must be an HTTPS issuer origin or a local development origin.",
    );
  }
  return {
    ...result.data,
    origin,
    auth: {
      issuer: issuer.href,
      clientId: AUTH0_CLIENT_ID,
      clientSecret: AUTH0_CLIENT_SECRET,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
