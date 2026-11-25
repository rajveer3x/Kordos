import {
  searchEmbeddingDimensions,
  type searchModelEnv,
} from "@kordos/contracts";
import { z } from "zod";
import { requestModel } from "./operations.js";
export {
  ModelQuotaError,
  modelOperations,
  modelOperationsEnv,
  requestModel,
  withModelOperation,
} from "./operations.js";

type Environment = z.infer<z.ZodObject<typeof searchModelEnv>>;

const embeddingResponse = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z
        .array(z.number().min(-1).max(1))
        .length(searchEmbeddingDimensions)
        .refine((values) => values.some((value) => Math.abs(value) > 1e-8)),
    }),
  ),
});

export function modelRequest({
  apiKey,
  baseUrl,
  timeoutMs,
  provider = "openai",
}: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  provider?: "openai" | "groq";
}) {
  const base = new URL(baseUrl.replace(/\/$/, "") + "/");
  if (
    base.protocol !== "https:" &&
    (process.env.NODE_ENV === "production" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
  )
    throw new Error(
      "Search models require HTTPS or a local development endpoint.",
    );

  return (path: string, body: { model: string; [key: string]: unknown }) => {
    return requestModel(provider, body.model, new URL(path, base), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
}

export function searchProvider(settings: Environment) {
  if (!settings.OPENAI_API_KEY) return;
  const run = modelRequest({
    apiKey: settings.OPENAI_API_KEY,
    baseUrl: settings.OPENAI_SEARCH_BASE_URL ?? settings.OPENAI_BASE_URL,
    timeoutMs: settings.OPENAI_SEARCH_TIMEOUT_MS,
  });
  const model = settings.OPENAI_SEARCH_EMBEDDING_MODEL;
  return {
    run,
    embeddings: model
      ? {
          model,
          async embed(input: string[]) {
            const { data } = embeddingResponse.parse(
              await run("embeddings", {
                model,
                input,
                dimensions: searchEmbeddingDimensions,
              }),
            );
            const ordered = data.sort((a, b) => a.index - b.index);
            if (
              input.length !== ordered.length ||
              !ordered.every((item, index) => item.index === index)
            )
              throw new Error("Incomplete search embedding response.");
            return ordered.map(({ embedding }) => embedding);
          },
        }
      : undefined,
  };
}
