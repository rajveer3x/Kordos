import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { connectorDeliverySchema, idSchema } from "@kordos/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConnectorStore } from "./routes.js";

const headers = z.object({
  "x-kordos-delivery": z.string().regex(/^[a-zA-Z0-9._-]{1,160}$/),
  "x-kordos-signature": z.string().regex(/^sha256=[0-9a-f]{64}$/),
});

export function registerConnectorIngress(
  app: FastifyInstance,
  db: ConnectorStore,
  secret: string,
) {
  app.register(async (api) => {
    api.removeContentTypeParser("application/json");
    api.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 512_000 },
      (_request, body, done) => done(null, body),
    );
    api.post<{ Params: { id: string }; Body: Buffer }>(
      "/api/connectors/fixture/:id/deliveries",
      async (request, reply) => {
        const id = idSchema.safeParse(request.params.id);
        const parsed = headers.safeParse(request.headers);
        reply.header("Cache-Control", "no-store");
        if (!id.success || !parsed.success || !Buffer.isBuffer(request.body))
          return reply.code(401).send();
        const delivery = parsed.data["x-kordos-delivery"];
        const actual = Buffer.from(
          parsed.data["x-kordos-signature"].slice(7),
          "hex",
        );
        const expected = createHmac("sha256", secret)
          .update(`${id.data}\n${delivery}\n`)
          .update(request.body)
          .digest();
        if (!timingSafeEqual(actual, expected)) return reply.code(401).send();
        let body: unknown;
        try {
          body = JSON.parse(request.body.toString("utf8"));
        } catch {
          return reply.code(400).send();
        }
        const payload = connectorDeliverySchema.safeParse(body);
        if (!payload.success) return reply.code(400).send();
        try {
          const result = await db.receive(
            id.data,
            delivery,
            createHash("sha256").update(request.body).digest("hex"),
            payload.data,
          );
          if (!result) return reply.code(404).send();
          if (result.result !== "saved") return reply.code(409).send();
          request.log.info({
            event: "connector.receipt",
            operationId: result.id,
            provider: "fixture",
          });
          return reply.code(202).send({ id: result.id });
        } catch {
          request.log.error("Connector receipt could not be persisted");
          return reply.code(503).send();
        }
      },
    );
  });
}
