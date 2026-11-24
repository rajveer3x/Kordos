import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { githubNumberSchema, githubRepositorySchema } from "@kordos/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConnectorStore } from "./routes.js";

const headers = z.object({
  "x-github-delivery": z.uuid(),
  "x-hub-signature-256": z.string().regex(/^sha256=[a-f0-9]{64}$/),
  "x-github-event": z.string().regex(/^[a-z_]{1,50}$/),
});
const installation = z.object({
  action: z.string(),
  installation: z.object({ id: githubNumberSchema }),
});
const repository = z.object({
  id: githubNumberSchema,
  full_name: githubRepositorySchema,
});
const reference = z.object({ number: githubNumberSchema });
const change = installation.extend({
  repository,
  issue: reference.optional(),
  pull_request: reference.optional(),
});
const scopeChanges = installation.extend({
  repositories_removed: z.array(repository).optional(),
  repositories_added: z.array(repository).optional(),
  repository: repository.optional(),
});

export function registerGitHubIngress(
  app: FastifyInstance,
  db: ConnectorStore,
  secret: string,
  bindings: Record<string, string>,
) {
  app.register(async (api) => {
    api.removeContentTypeParser("application/json");
    api.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 2_000_000 },
      (_request, body, done) => done(null, body),
    );

    api.post<{ Body: Buffer }>(
      "/api/connectors/github/webhook",
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = headers.safeParse(request.headers);
        if (!parsed.success || !Buffer.isBuffer(request.body))
          return reply.code(401).send();
        const actual = Buffer.from(
          parsed.data["x-hub-signature-256"].slice(7),
          "hex",
        );
        const expected = createHmac("sha256", secret)
          .update(request.body)
          .digest();
        if (!timingSafeEqual(actual, expected)) return reply.code(401).send();

        const event = parsed.data["x-github-event"];
        if (
          ![
            "issues",
            "pull_request",
            "installation",
            "installation_repositories",
            "repository",
          ].includes(event)
        ) {
          return reply.code(202).send();
        }
        let payload: unknown;
        try {
          payload = JSON.parse(request.body.toString("utf8")) as unknown;
        } catch {
          return reply.code(400).send();
        }
        const parent = installation.safeParse(payload);
        if (!parent.success) return reply.code(400).send();
        const id = String(parent.data.installation.id);
        const workspace = bindings[id];
        if (!workspace) return reply.code(202).send();
        try {
          if (event === "issues" || event === "pull_request") {
            const data = change.safeParse(payload);
            if (!data.success) return reply.code(400).send();
            const kind = event === "issues" ? "issue" : "pull";
            const item =
              kind === "issue" ? data.data.issue : data.data.pull_request;
            if (!item) return reply.code(400).send();
            const hash = createHash("sha256")
              .update(event + "\n")
              .update(request.body)
              .digest("hex");
            const result = await db.githubReceive(
              workspace,
              id,
              parsed.data["x-github-delivery"],
              hash,
              data.data.repository.full_name,
              {
                kind,
                number: item.number,
                repositoryId: String(data.data.repository.id),
              },
            );
            if (result && result.result !== "saved")
              return reply.code(409).send();
            if (result)
              request.log.info({
                event: "connector.receipt",
                operationId: result.id,
                workspaceId: workspace,
                provider: "github",
              });
            return reply.code(202).send(result ? { id: result.id } : undefined);
          }

          const data = scopeChanges.safeParse(payload);
          if (!data.success) return reply.code(400).send();
          if (event === "installation") {
            await db.githubInvalidate(workspace, id, null);
          } else if (event === "installation_repositories") {
            const scopes = [
              ...(data.data.repositories_removed ?? []),
              ...(data.data.repositories_added ?? []),
            ];
            await db.githubInvalidate(
              workspace,
              id,
              scopes.map(({ full_name }) => full_name),
            );
          } else if (
            data.data.repository &&
            [
              "deleted",
              "privatized",
              "publicized",
              "renamed",
              "transferred",
            ].includes(data.data.action)
          ) {
            // Recheck all mappings on rename or transfer. The payload names the new repository.
            await db.githubInvalidate(
              workspace,
              id,
              ["renamed", "transferred"].includes(data.data.action)
                ? null
                : [data.data.repository.full_name],
            );
          }
          return reply.code(202).send();
        } catch {
          request.log.error("GitHub receipt could not be persisted");
          return reply.code(503).send();
        }
      },
    );
  });
}
