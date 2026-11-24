import { afterEach, expect, it, vi } from "vitest";
import { transcribeMeeting } from "./meeting-transcription.js";

afterEach(() => vi.unstubAllGlobals());

it("preserves Groq transcript timestamps and leaves speakers unlabeled", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      text: "We can ship.",
      segments: [{ id: 0, start: 0.22, end: 1.58, text: " We can ship." }],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await transcribeMeeting(
    {
      provider: "groq",
      apiKey: "fixture-groq-key",
      baseUrl: "https://api.groq.com/openai/v1/",
      model: "whisper-large-v3-turbo",
      timeoutMs: 1000,
    },
    new Uint8Array([1, 2, 3]),
    "wav",
  );

  expect(result).toMatchObject({
    segments: [
      { text: "We can ship.", startMs: 220, endMs: 1580, speaker: null },
    ],
  });
  const [url, request] = fetch.mock.calls[0]!;
  expect(url.toString()).toBe(
    "https://api.groq.com/openai/v1/audio/transcriptions",
  );
  expect(request?.headers).toMatchObject({
    authorization: "Bearer fixture-groq-key",
  });
  expect(request?.body).toBeInstanceOf(FormData);
  const form = request?.body as FormData;
  expect(form.get("model")).toBe("whisper-large-v3-turbo");
  expect(form.get("response_format")).toBe("verbose_json");
  expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
  expect(form.has("chunking_strategy")).toBe(false);
});
