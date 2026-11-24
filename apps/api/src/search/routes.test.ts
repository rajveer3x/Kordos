import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { registerSearch } from "./routes.js";

afterEach(() => vi.unstubAllGlobals());

it("uses Groq for cited keyword results and keeps local passages after a rate limit", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://fixture@127.0.0.1/kordos",
    REDIS_URL: "redis://127.0.0.1",
    STORAGE_ENDPOINT: "http://127.0.0.1",
    STORAGE_REGION: "test",
    STORAGE_BUCKET: "kordos-test",
    STORAGE_ACCESS_KEY_ID: "fixture",
    STORAGE_SECRET_ACCESS_KEY: "fixture",
    GROQ_API_KEY: "fixture-groq-key",
    OPENAI_API_KEY: "fixture-openai-key",
    OPENAI_SEARCH_EMBEDDING_MODEL: "fixture-embeddings",
  });
  const source = {
    id: randomUUID(),
    kind: "decision" as const,
    projectId: randomUUID(),
    project: "Release",
    title: "Rollout decision",
    excerpt: "Roll out in two phases.",
    attribution: "Mira",
    date: "2026-11-24",
    revision: 1,
    externalId: null,
    citation: null,
    modelAllowed: true,
  };
  const actor = randomUUID();
  const workspace = randomUUID();
  const query = vi.fn(async () => ({
    mode: "lexical" as const,
    items: [source],
    indexing: false,
    hasMore: false,
  }));
  const canSearch = vi.fn(async () => true);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"status":"supported","passages":[1]}' },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", fetch);
  const api = Fastify();
  registerSearch(
    api,
    { query, canSearch, owners: async () => [] },
    async () => actor,
    config,
  );
  const answer = () =>
    api.inject({
      method: "POST",
      url: `/workspaces/${workspace}/search/answer`,
      payload: { q: "rollout" },
    });
  try {
    const supported = await answer();
    expect(supported.statusCode).toBe(200);
    expect(supported.json()).toMatchObject({
      status: "supported",
      passages: [{ id: source.id, excerpt: source.excerpt }],
    });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer fixture-groq-key",
    });
    expect(query).toHaveBeenCalledWith(
      actor,
      workspace,
      { q: "rollout" },
      undefined,
      undefined,
    );
    expect(canSearch).not.toHaveBeenCalled();

    const limited = await answer();
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toMatchObject({
      status: "insufficient",
      passages: [{ id: source.id, excerpt: source.excerpt }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await api.close();
  }
});
