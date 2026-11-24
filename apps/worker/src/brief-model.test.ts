import { randomUUID } from "node:crypto";
import type { ModelBrief } from "@kordos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBrief, groundBrief } from "./brief-model.js";

describe("brief extraction grounding", () => {
  const ownerId = randomUUID();
  const quote = "Release on Friday. Find a reviewer.";
  const source = {
    capturedAt: "2026-11-20T00:30:00Z",
    timeZone: "America/Los_Angeles",
    sourceRevision: 2,
    content: "🧭\n" + quote,
    owners: [{ id: ownerId, name: "Mira" }],
  };
  const task: ModelBrief["tasks"][number] = {
    id: "release",
    title: "Release",
    description: null,
    owner: "Mira",
    estimateDays: null,
    estimateInferred: false,
    deadline: { kind: "relative", value: "friday" },
    quote,
  };

  it("resolves dates from the source timezone and drops unsupported owners", () => {
    const result = groundBrief({ tasks: [task], edges: [] }, source);
    expect(result).toMatchObject({
      plan: {
        tasks: [
          {
            deadline: "2026-11-20",
            ownerId: null,
            certainty: {
              owner: "missing",
              estimate: "missing",
              deadline: "inferred",
            },
            passages: [{ revision: 2, start: 2, end: 2 + quote.length }],
          },
        ],
      },
    });
    expect(
      groundBrief(
        {
          tasks: [{ ...task, deadline: { kind: "relative", value: "today" } }],
          edges: [],
        },
        source,
      ),
    ).toMatchObject({ plan: { tasks: [{ deadline: null }] } });
    expect(
      groundBrief(
        {
          tasks: [
            {
              ...task,
              deadline: { kind: "relative", value: "today" },
              quote: "Release today.",
            },
          ],
          edges: [],
        },
        { ...source, content: "Release today." },
      ),
    ).toMatchObject({ plan: { tasks: [{ deadline: "2026-11-19" }] } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends Groq-compatible structured requests and grounds the returned plan", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ tasks: [task], edges: [] }) },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const config = {
      provider: "groq" as const,
      apiKey: "fixture-groq-key",
      baseUrl: "https://api.groq.com/openai/v1/",
      model: "openai/gpt-oss-20b",
      timeoutMs: 1000,
    };
    const brief = { ...source, title: "Release brief" };
    await expect(extractBrief(config, brief)).resolves.toMatchObject({
      plan: { tasks: [{ title: "Release", passages: [{ revision: 2 }] }] },
    });

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(request?.headers).toMatchObject({
      authorization: "Bearer fixture-groq-key",
    });
    const body = JSON.parse(String(request?.body));
    expect(body).not.toHaveProperty("store");
    const { anyOf } =
      body.response_format.json_schema.schema.properties.tasks.items.properties
        .deadline;
    expect(anyOf).toEqual([
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["absolute", "relative"] },
          value: { type: "string" },
        },
        required: ["kind", "value"],
        additionalProperties: false,
      },
      { type: "null" },
    ]);
    expect(body).toMatchObject({
      model: config.model,
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });

    fetch.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(extractBrief(config, brief)).resolves.toEqual({
      failure: "provider_unavailable",
    });
  });

  it("rejects fabricated or ambiguous spans and invalid model dependencies", () => {
    expect(
      groundBrief(
        { tasks: [{ ...task, quote: "Never in the source" }], edges: [] },
        source,
      ),
    ).toEqual({ failure: "invalid_output" });
    expect(
      groundBrief(
        { tasks: [task], edges: [] },
        { ...source, content: quote.repeat(2) },
      ),
    ).toEqual({ failure: "invalid_output" });
    expect(
      groundBrief(
        {
          tasks: [task],
          edges: [{ predecessorId: task.id, successorId: task.id }],
        },
        source,
      ),
    ).toEqual({ failure: "invalid_output" });
  });
});
