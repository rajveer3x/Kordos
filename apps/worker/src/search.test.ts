import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ModelQuotaError, modelOperations } from "@kordos/search-model";
import { processEmbeddingBatch } from "./search.js";

it("defers quota-exhausted workspaces without blocking other tenants", async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const chunkA = randomUUID();
  const chunkB = randomUUID();
  const lease = randomUUID();

  const claim = vi
    .fn()
    .mockResolvedValueOnce({
      lease,
      chunks: [
        { id: chunkA, workspaceId: tenantA, title: "A", passage: "alpha" },
        { id: chunkB, workspaceId: tenantB, title: "B", passage: "beta" },
      ],
    })
    .mockResolvedValueOnce({ lease: randomUUID(), chunks: [] });
  const finish = vi.fn(async () => {});
  const defer = vi.fn(async () => {});
  const db = { claim, finish, defer };

  const embed = vi.fn(async (inputs: string[]) => {
    if (inputs[0]?.startsWith("A\n")) {
      throw new ModelQuotaError("limited", 1200);
    }
    return inputs.map(() => [0.1, 0.2]);
  });
  const meter = modelOperations(
    { eval: vi.fn(async () => 1) },
    {
      MODEL_INTERACTIVE_DAILY_LIMIT: 10,
      MODEL_INDEX_DAILY_LIMIT: 10,
      MODEL_PRICES_USD: {},
    },
  );

  const quotaLimitedUntil = new Map<string, number>();
  const signal = new AbortController().signal;

  const worked = await processEmbeddingBatch(
    db,
    { model: "text-embedding-3-small", embed },
    meter,
    quotaLimitedUntil,
    signal,
  );
  expect(worked).toBe(true);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledWith("text-embedding-3-small", lease, [
    { id: chunkB, embedding: [0.1, 0.2] },
  ]);
  expect(defer).toHaveBeenCalledWith(
    lease,
    tenantA,
    "text-embedding-3-small",
    1200,
  );
  expect(quotaLimitedUntil.has(tenantA)).toBe(true);
  expect(quotaLimitedUntil.has(tenantB)).toBe(false);

  const second = await processEmbeddingBatch(
    db,
    { model: "text-embedding-3-small", embed },
    meter,
    quotaLimitedUntil,
    signal,
  );
  expect(second).toBe(false);
  expect(claim).toHaveBeenNthCalledWith(2, "text-embedding-3-small", [tenantA]);
});
