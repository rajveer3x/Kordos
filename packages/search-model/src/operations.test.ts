import { expect, test, vi } from "vitest";
import {
  modelOperations,
  requestModel,
  withModelOperation,
} from "./operations.js";

test("meters provider calls with usage and estimated cost while keeping payloads out of logs", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const request = vi.fn().mockResolvedValue(
    Response.json({
      usage: { prompt_tokens: 800, completion_tokens: 200 },
      answer: "Private fixture output",
    }),
  );
  vi.stubGlobal("fetch", request);
  const reserve = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const meter = modelOperations(
    { eval: reserve },
    {
      MODEL_INTERACTIVE_DAILY_LIMIT: 1,
      MODEL_INDEX_DAILY_LIMIT: 5,
      MODEL_PRICES_USD: {
        "openai/fixture": { inputPerMillion: 2, outputPerMillion: 4 },
      },
    },
  );
  const run = () =>
    withModelOperation(
      meter,
      {
        workspaceId: "fixture-workspace",
        operationId: "fixture-request",
      },
      "cited_answer",
      () =>
        requestModel(
          "openai",
          "fixture",
          new URL("https://model.example.test/"),
          {
            method: "POST",
            body: "Private fixture input",
          },
        ),
    );

  try {
    await run();
    await expect(run()).rejects.toThrow("Model request quota");
    expect(request).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "kordos:model-quota:fixture-workspace:interactive",
      1,
    );
    const events = log.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "provider.model",
        status: 200,
        inputTokens: 800,
        outputTokens: 200,
        estimatedCostUsd: 0.0024,
        operationId: "fixture-request",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "model.quota", outcome: "limited" }),
    );
    expect(JSON.stringify(events)).not.toContain("Private fixture");
  } finally {
    vi.unstubAllGlobals();
    log.mockRestore();
  }
});
