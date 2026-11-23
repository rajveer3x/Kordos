import type { S3Client } from "@aws-sdk/client-s3";
import cookie from "@fastify/cookie";
import {
  acceptInvitationSchema,
  createInvitationSchema,
  createWorkspaceSchema,
  idSchema,
  updateMemberSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { attachCollaboration } from "../collaboration/live.js";
import { registerCollaboration } from "../collaboration/routes.js";
import type { Config } from "../config.js";
import { registerKnowledge } from "../knowledge/routes.js";
import { registerForecast } from "../planning/forecast-routes.js";
import { registerPlanning } from "../planning/routes.js";
import { registerBriefs } from "../briefs/routes.js";
import { registerRisks } from "../risks/routes.js";
import { registerReviews } from "../reviews/routes.js";
import { IdentityError, parse, unavailable } from "./http.js";
import { createSessionService, digest, opaqueToken } from "./session.js";

const workspaceParams = z.object({ workspaceId: idSchema });
const memberParams = workspaceParams.extend({ userId: idSchema });

export function registerIdentity(
  app: FastifyInstance,
  config: Config,
  redis: Redis,
  stores: Pick<
    ReturnType<typeof connectDatabase>,
    | "identity"
    | "planning"
    | "forecast"
    | "collaboration"
    | "knowledge"
    | "reviews"
    | "risks"
    | "briefs"
  >,
  storage: S3Client,
) {
  const session = createSessionService(config, redis);
  const db = stores.identity;

  app.register(
    async (api) => {
      await api.register(cookie);
      attachCollaboration(
        api,
        redis,
        config.origin.origin,
        stores.collaboration,
        (header) => session.actor(api.parseCookie(header)),
      );
      api.addHook("onRequest", async (request, reply) => {
        reply
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer");
        if (
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.headers.origin !== config.origin.origin
        ) {
          throw new IdentityError(
            403,
            "forbidden",
            "This request is not allowed.",
          );
        }
      });
      api.setErrorHandler((error, request, reply) => {
        if (error instanceof IdentityError) {
          return reply.code(error.status).send({
            code: error.code,
            message: error.message,
            current: error.current,
          });
        }
        if (
          error instanceof Error &&
          "statusCode" in error &&
          typeof error.statusCode === "number" &&
          error.statusCode < 500
        ) {
          return reply.code(error.statusCode).send({
            code: "invalid_input",
            message: "Check the information you entered.",
          });
        }
        const code =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined;
        request.log.error({ code }, "Workspace request failed");
        return reply.code(503).send({
          code: "unavailable",
          message: "The workspace is temporarily unavailable. Try again.",
        });
      });

      async function requireActor(request: FastifyRequest) {
        const actor = await session.actor(request.cookies);
        if (actor) return actor;
        throw new IdentityError(401, "signed_out", "Sign in to continue.");
      }

      registerPlanning(api, stores.planning, requireActor);
      registerReviews(api, stores, requireActor);
      registerRisks(api, stores.risks, requireActor);
      registerBriefs(api, stores.briefs, requireActor);
      registerForecast(api, stores.forecast, requireActor);
      registerCollaboration(api, stores.collaboration, requireActor);
      registerKnowledge(
        api,
        stores.knowledge,
        requireActor,
        storage,
        config.STORAGE_BUCKET,
      );

      api.post("/auth/login", async (request, reply) => {
        if (!config.auth) throw unavailable();
        const { returnTo } = parse(
          z.object({ returnTo: z.string().max(2048) }),
          request.body,
        );
        const destination = returnTo.startsWith("/")
          ? URL.parse(returnTo, config.origin)
          : null;
        const target =
          destination?.origin === config.origin.origin
            ? destination.href
            : new URL("/workspace", config.origin).href;
        return { url: await session.startLogin(target, reply) };
      });

      api.get("/auth/callback", async (request, reply) => {
        if (!config.auth) throw unavailable();
        try {
          const { profile, returnTo } = await session.finishLogin(
            request,
            reply,
          );
          const actor = await db.recordSignIn(profile);
          await session.setActor(request, reply, actor);
          return reply.redirect(new URL(returnTo, config.origin).href);
        } catch {
          request.log.warn(
            { requestId: request.id },
            "OIDC sign-in did not complete",
          );
          return reply.redirect(
            new URL("/sign-in?error=sign-in", config.origin).href,
          );
        }
      });

      api.post("/auth/logout", async (request, reply) => {
        await session.signOut(request, reply);
        return reply.code(204).send();
      });

      api.get("/session", async (request) => {
        const actor = await session.actor(request.cookies);
        return {
          identity: (actor ? await db.session(actor) : null) ?? null,
          signInAvailable: Boolean(config.auth),
        };
      });

      api.get("/workspaces", async (request) =>
        db.workspaces(await requireActor(request)),
      );
      api.post("/workspaces", async (request, reply) => {
        const actor = await requireActor(request);
        const input = parse(createWorkspaceSchema, request.body);
        if (!(await db.createWorkspace(actor, input))) {
          throw new IdentityError(
            409,
            "conflict",
            "This workspace could not be created with that request.",
          );
        }
        return reply.code(201).send({ id: input.id });
      });

      api.get("/workspaces/:workspaceId", async (request) => {
        const actor = await requireActor(request);
        const { workspaceId } = parse(workspaceParams, request.params);
        const workspace = await db.workspace(actor, workspaceId);
        if (!workspace) throw unavailable();
        return workspace;
      });

      api.get("/workspaces/:workspaceId/members", async (request) => {
        const actor = await requireActor(request);
        const { workspaceId } = parse(workspaceParams, request.params);
        const members = await db.members(actor, workspaceId);
        if (!members) throw unavailable();
        return members;
      });

      api.patch(
        "/workspaces/:workspaceId/members/:userId",
        async (request, reply) => {
          const actor = await requireActor(request);
          const { workspaceId, userId } = parse(memberParams, request.params);
          const input = parse(updateMemberSchema, request.body);
          const { result, current } = await db.updateMember(
            actor,
            workspaceId,
            userId,
            input,
          );
          if (result === "updated") return reply.code(204).send();
          if (result === "last_admin") {
            throw new IdentityError(
              409,
              "last_admin",
              "Assign another administrator first.",
            );
          }
          if (result === "conflict") {
            throw new IdentityError(
              409,
              "conflict",
              "This membership changed. Review the latest role and try again.",
              current,
            );
          }
          throw unavailable();
        },
      );

      api.post(
        "/workspaces/:workspaceId/invitations",
        async (request, reply) => {
          const actor = await requireActor(request);
          const { workspaceId } = parse(workspaceParams, request.params);
          const input = parse(createInvitationSchema, request.body);
          const token = opaqueToken();
          const expiresAt = await db.createInvitation(
            actor,
            workspaceId,
            input,
            digest(token),
          );
          if (!expiresAt) throw unavailable();
          return reply.code(201).send({ token, expiresAt });
        },
      );

      api.post("/invitations/accept", async (request) => {
        const actor = await requireActor(request);
        const { token } = parse(acceptInvitationSchema, request.body);
        const id = await db.acceptInvitation(actor, digest(token));
        if (!id) {
          throw new IdentityError(
            404,
            "unavailable",
            "This invitation is unavailable. Check that you’re signed in with the invited, verified email.",
          );
        }
        return { id };
      });
    },
    { prefix: "/api" },
  );
}
