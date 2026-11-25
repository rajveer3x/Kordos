import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const rate = z.number().nonnegative().finite();
const prices = z.record(
  z.string(),
  z
    .object({
      inputPerMillion: rate.optional(),
      outputPerMillion: rate.optional(),
      audioPerHour: rate.optional(),
    })
    .strict(),
);

export const modelOperationsEnv = {
  MODEL_INTERACTIVE_DAILY_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(1000),
  MODEL_INDEX_DAILY_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(2000),
  MODEL_PRICES_USD: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }, prices.default({})),
};

type Settings = z.infer<z.ZodObject<typeof modelOperationsEnv>>;
type Scope = { workspaceId: string; operationId: string };
type Operation =
  | "brief"
  | "transcription"
  | "search_embedding"
  | "cited_answer"
  | "index_embedding";

const reserve = `
  local count = tonumber(redis.call('GET', KEYS[1]) or '0')
  if count >= tonumber(ARGV[1]) then return 0 end
  count = redis.call('INCR', KEYS[1])
  if count == 1 then
    local now = tonumber(redis.call('TIME')[1])
    redis.call('EXPIREAT', KEYS[1], now - now % 86400 + 86400)
  end
  return count
`;

export class ModelQuotaError extends Error {
  constructor(
    readonly outcome: "limited" | "unavailable",
    readonly retryAfterSeconds: number,
  ) {
    super("Model request quota is unavailable or exhausted.");
  }
}

export function modelOperations(
  redis: {
    eval(
      script: string,
      keys: number,
      key: string,
      limit: number,
    ): Promise<unknown>;
  },
  settings: Settings,
) {
  async function reserveQuota(scope: Scope, operation: Operation) {
    const index = operation === "index_embedding";
    const bucket = index ? "index" : "interactive";
    const limit = index
      ? settings.MODEL_INDEX_DAILY_LIMIT
      : settings.MODEL_INTERACTIVE_DAILY_LIMIT;
    const used = await redis
      .eval(
        reserve,
        1,
        `kordos:model-quota:${scope.workspaceId}:${bucket}`,
        limit,
      )
      .catch(() => undefined);
    const outcome: "allowed" | "limited" | "unavailable" = !Number.isInteger(
      used,
    )
      ? "unavailable"
      : used === 0
        ? "limited"
        : "allowed";
    console.info(
      JSON.stringify({
        event: "model.quota",
        workspaceId: scope.workspaceId,
        operationId: scope.operationId,
        operation,
        bucket,
        limit,
        used,
        outcome,
      }),
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const retryAfterSeconds =
      outcome === "limited" ? Math.max(60, 86400 - (nowSeconds % 86400)) : 60;
    return { allowed: outcome === "allowed", outcome, retryAfterSeconds };
  }

  return {
    prices: settings.MODEL_PRICES_USD,
    reserve: reserveQuota,
    async authorize(scope: Scope, operation: Operation) {
      return (await reserveQuota(scope, operation)).allowed;
    },
  };
}

type ModelContext = Scope & {
  meter: ReturnType<typeof modelOperations>;
  operation: Operation;
};
const context = new AsyncLocalStorage<ModelContext>();

export function withModelOperation<T>(
  meter: ReturnType<typeof modelOperations> | undefined,
  scope: Scope,
  operation: Operation,
  run: () => T,
): T {
  return meter ? context.run({ ...scope, meter, operation }, run) : run();
}

const usageSchema = z.object({
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      seconds: rate.optional(),
    })
    .optional(),
  duration: rate.optional(),
});

export async function requestModel(
  provider: "openai" | "groq",
  model: string,
  url: URL,
  init: RequestInit,
): Promise<unknown> {
  const active = context.getStore();
  if (active) {
    const decision = await active.meter.reserve(active, active.operation);
    if (!decision.allowed && decision.outcome !== "allowed") {
      throw new ModelQuotaError(decision.outcome, decision.retryAfterSeconds);
    }
  }

  const start = performance.now();
  let status: number | undefined;
  let transportError: string | undefined;
  let outcome = "error";
  let usage: z.infer<typeof usageSchema> | undefined;
  try {
    const response = await fetch(url, init);
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Model request failed.");
    }
    const data: unknown = await response.json();
    if (active) usage = usageSchema.safeParse(data).data;
    outcome = "ok";
    return data;
  } catch (error) {
    const code = z
      .object({
        cause: z.object({ code: z.string().regex(/^[A-Z][A-Z_0-9]{1,39}$/) }),
      })
      .safeParse(error).data?.cause.code;
    transportError = code ?? (init.signal?.aborted ? "TIMEOUT" : undefined);
    throw error;
  } finally {
    if (active) {
      const { workspaceId, operationId, operation, meter } = active;
      const rateCard = meter.prices[`${provider}/${model}`];
      const inputTokens = usage?.usage?.prompt_tokens;
      const outputTokens = usage?.usage?.completion_tokens;
      const audioSeconds = usage?.usage?.seconds ?? usage?.duration;
      const estimatedCostUsd =
        audioSeconds !== undefined && rateCard?.audioPerHour !== undefined
          ? (audioSeconds * rateCard.audioPerHour) / 3600
          : inputTokens !== undefined &&
              rateCard?.inputPerMillion !== undefined &&
              (outputTokens === undefined ||
                rateCard.outputPerMillion !== undefined)
            ? (inputTokens * rateCard.inputPerMillion +
                (outputTokens ?? 0) * (rateCard.outputPerMillion ?? 0)) /
              1000000
            : null;
      console.info(
        JSON.stringify({
          event: "provider.model",
          provider,
          model,
          operation,
          operationId,
          workspaceId,
          durationMs: Math.round(performance.now() - start),
          status,
          outcome,
          inputTokens,
          outputTokens,
          audioSeconds,
          estimatedCostUsd,
          transportError,
        }),
      );
    }
  }
}
