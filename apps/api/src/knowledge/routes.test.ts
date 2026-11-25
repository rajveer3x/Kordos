import { randomUUID } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerKnowledge } from "./routes.js";

it("aborts the attachment reservation when object storage upload fails", async () => {
  const actor = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const documentId = randomUUID();
  const mutationId = randomUUID();

  const upload = vi.fn(async () => ({
    result: "pending" as const,
    key: `attachments/${workspaceId}/${projectId}/${documentId}/file`,
  }));
  const abortUpload = vi.fn(async () => {});
  const store = {
    documents: vi.fn(),
    document: vi.fn(),
    saveDocument: vi.fn(),
    decisions: vi.fn(),
    saveDecision: vi.fn(),
    resolveCitation: vi.fn(),
    attachment: vi.fn(),
    upload,
    abortUpload,
  };
  const storage = {
    send: vi.fn(async () => {
      throw new Error("Storage unavailable");
    }),
  } as unknown as S3Client;

  const api = Fastify();
  registerKnowledge(
    api,
    store as never,
    async () => actor,
    storage,
    "kordos-test",
  );

  try {
    const response = await api.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/projects/${projectId}/documents/${documentId}/attachments?name=notes.txt&mutationId=${mutationId}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("hello"),
    });
    expect(response.statusCode).toBe(500);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(abortUpload).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ workspaceId, projectId }),
      documentId,
      mutationId,
    );
  } finally {
    await api.close();
  }
});
