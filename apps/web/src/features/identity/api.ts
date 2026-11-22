import { identityErrorSchema } from "@kordos/contracts";
import type { ZodType } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly current?: unknown,
  ) {
    super(message);
  }
}

export async function request<T = void>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    schema?: ZodType<T>;
    signal?: AbortSignal;
  } = {},
) {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = identityErrorSchema.safeParse(
      await response.json().catch(() => null),
    );
    throw new ApiError(
      response.status,
      body.success ? body.data.message : "The request failed. Try again.",
      body.success ? body.data.current : undefined,
    );
  }
  if (options.schema) return options.schema.parse(await response.json());
}

export async function read<T>(
  path: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
) {
  const response = await request(path, { schema, signal });
  if (response === undefined) throw new Error("Empty response.");
  return response;
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : "The request failed. Try again.";
}

export function denied(error: unknown) {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 404)
  );
}
