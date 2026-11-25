import { randomUUID } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerMeetings } from "./routes.js";

function waveBytes() {
  const bytes = Buffer.alloc(64);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WAVE", 8, "ascii");
  return bytes;
}

it("aborts the meeting audio reservation when object storage upload fails", async () => {
  const actor = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const meetingId = randomUUID();
  const mutationId = randomUUID();

  const upload = vi.fn(async () => ({
    result: "pending",
    key: `meetings/${workspaceId}/${projectId}/${meetingId}/media`,
    id: randomUUID(),
  }));
  const abortUpload = vi.fn(async () => {});
  const store = {
    directory: vi.fn(),
    detail: vi.fn(),
    write: vi.fn(),
    item: vi.fn(),
    upload,
    abortUpload,
    audio: vi.fn(),
    origin: vi.fn(),
  };
  const storage = {
    send: vi.fn(async () => {
      throw new Error("Storage unavailable");
    }),
  } as unknown as S3Client;

  const api = Fastify();
  registerMeetings(
    api,
    store as never,
    async () => actor,
    storage,
    "kordos-test",
  );

  try {
    const response = await api.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/projects/${projectId}/meetings/${meetingId}/audio?extension=wav&authorized=true&mutationId=${mutationId}&expectedVersion=1`,
      headers: { "content-type": "application/octet-stream" },
      payload: waveBytes(),
    });
    expect(response.statusCode).toBe(500);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(abortUpload).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ workspaceId, projectId }),
      meetingId,
      mutationId,
    );
  } finally {
    await api.close();
  }
});
