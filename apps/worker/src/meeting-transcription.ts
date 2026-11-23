import { randomUUID } from "node:crypto";
import {
  meetingAudioTypes,
  meetingTranscriptSchema,
  type MeetingFailure,
  type MeetingSegment,
  type meetingAudioExtensionSchema,
} from "@kordos/contracts";
import { z } from "zod";

const responseSchema = z.object({
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().positive(),
        text: z.string(),
        speaker: z.string().trim().max(100).nullish(),
      }),
    )
    .min(1)
    .max(320),
});
export type TranscriptionConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export async function transcribeMeeting(
  config: TranscriptionConfig | undefined,
  bytes: Uint8Array,
  extension: z.infer<typeof meetingAudioExtensionSchema>,
): Promise<{ segments: MeetingSegment[] } | { failure: MeetingFailure }> {
  if (!config) return { failure: "provider_unavailable" };
  const body = new FormData();
  body.set(
    "file",
    new Blob([Uint8Array.from(bytes)], { type: meetingAudioTypes[extension] }),
    `recording.${extension}`,
  );
  body.set("model", config.model);
  body.set("response_format", "diarized_json");
  body.set("chunking_strategy", "auto");
  const signal = AbortSignal.timeout(config.timeoutMs);
  let response: unknown;
  try {
    const result = await fetch(
      new URL("audio/transcriptions", config.baseUrl.replace(/\/?$/, "/")),
      {
        method: "POST",
        body,
        signal,
        redirect: "error",
        headers: { authorization: `Bearer ${config.apiKey}` },
      },
    );
    if (!result.ok) return { failure: "provider_unavailable" };
    response = await result.json();
  } catch (error) {
    return {
      failure: signal.aborted
        ? "timeout"
        : error instanceof SyntaxError
          ? "invalid_transcript"
          : "provider_unavailable",
    };
  }
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) return { failure: "invalid_transcript" };
  const segments = meetingTranscriptSchema.safeParse(
    parsed.data.segments.flatMap((segment) => {
      const text = segment.text.trim();
      if (!text) return [];
      return [
        {
          id: randomUUID(),
          text,
          speaker: segment.speaker || null,
          startMs: Math.round(segment.start * 1000),
          endMs: Math.round(segment.end * 1000),
        },
      ];
    }),
  );
  return segments.success
    ? { segments: segments.data }
    : { failure: "invalid_transcript" };
}
