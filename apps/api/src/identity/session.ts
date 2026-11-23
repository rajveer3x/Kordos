import { createHash, randomBytes } from "node:crypto";
import { emailSchema, idSchema } from "@kordos/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import * as oidc from "openid-client";
import { z } from "zod";
import type { Config } from "../config.js";

const sessionLifetime = 12 * 60 * 60;
const flowLifetime = 10 * 60;
const flowSchema = z.object({
  verifier: z.string(),
  state: z.string(),
  nonce: z.string(),
  returnTo: z.string(),
});
const profileSchema = z.object({
  sub: z.string().min(1).max(255),
  name: z.string().trim().min(1).max(200).catch(""),
  email: emailSchema.nullable().catch(null),
  email_verified: z.boolean().catch(false),
});

export const opaqueToken = () => randomBytes(32).toString("base64url");
export const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function createSessionService(config: Config, redis: Redis) {
  const origin = config.origin;
  const secure = origin.protocol === "https:";
  const callback = new URL("/api/auth/callback", origin);
  const sessionCookie = secure ? "__Host-kordos-session" : "kordos-session";
  const flowCookie = secure ? "__Host-kordos-login" : "kordos-login";
  const cookie = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
  } as const;
  let provider: Promise<oidc.Configuration> | undefined;

  function discover() {
    const auth = config.auth;
    if (!auth) throw new Error("Auth0 is unavailable.");
    const issuer = new URL(auth.issuer);
    provider ??= oidc
      .discovery(issuer, auth.clientId, auth.clientSecret, undefined, {
        timeout: 5,
        execute: [
          ...(issuer.protocol === "http:" ? [oidc.allowInsecureRequests] : []),
          oidc.enableNonRepudiationChecks,
        ],
      })
      .catch((error: unknown) => {
        provider = undefined;
        throw error;
      });
    return provider;
  }

  function sessionKey(cookies: FastifyRequest["cookies"]) {
    const token = cookies[sessionCookie];
    return token && `kordos:session:${digest(token)}`;
  }

  return {
    sessionKey,
    async actor(cookies: FastifyRequest["cookies"]) {
      const key = sessionKey(cookies);
      if (!key) return;
      const parsed = idSchema.safeParse(await redis.get(key));
      return parsed.success ? parsed.data : undefined;
    },
    async startLogin(returnTo: string, reply: FastifyReply) {
      const client = await discover();
      const id = opaqueToken();
      const flow = {
        verifier: oidc.randomPKCECodeVerifier(),
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        returnTo,
      };
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: callback.href,
        scope: "openid profile email",
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: "S256",
        prompt: "login",
      });
      await redis.set(
        `kordos:login:${digest(id)}`,
        JSON.stringify(flow),
        "EX",
        flowLifetime,
      );
      reply.setCookie(flowCookie, id, { ...cookie, maxAge: flowLifetime });
      return url.href;
    },
    async finishLogin(request: FastifyRequest, reply: FastifyReply) {
      const id = request.cookies[flowCookie];
      if (!id) throw new Error("The sign-in attempt has expired.");
      reply.clearCookie(flowCookie, cookie);
      const saved = await redis.getdel(`kordos:login:${digest(id)}`);
      const flow = flowSchema.parse(saved ? JSON.parse(saved) : null);
      const url = new URL(callback);
      const queryStart = request.url.indexOf("?");
      if (queryStart >= 0) url.search = request.url.slice(queryStart);
      const client = await discover();
      const tokens = await oidc.authorizationCodeGrant(client, url, {
        pkceCodeVerifier: flow.verifier,
        expectedNonce: flow.nonce,
        expectedState: flow.state,
        idTokenExpected: true,
      });
      const claims = z
        .object({ sub: z.string().min(1), iss: z.string().min(1) })
        .parse(tokens.claims());
      const profile = profileSchema.parse(
        await oidc.fetchUserInfo(client, tokens.access_token, claims.sub),
      );
      return {
        returnTo: flow.returnTo,
        profile: {
          issuer: claims.iss,
          subject: claims.sub,
          name: profile.name || profile.email || "Kordos member",
          email: profile.email,
          emailVerified: Boolean(
            profile.email && profile.email_verified === true,
          ),
        },
      };
    },
    async setActor(
      request: FastifyRequest,
      reply: FastifyReply,
      actorId: string,
    ) {
      const token = opaqueToken();
      const oldKey = sessionKey(request.cookies);
      if (oldKey) await redis.del(oldKey);
      await redis.set(
        `kordos:session:${digest(token)}`,
        actorId,
        "EX",
        sessionLifetime,
      );
      reply.setCookie(sessionCookie, token, {
        ...cookie,
        maxAge: sessionLifetime,
      });
    },
    async signOut(request: FastifyRequest, reply: FastifyReply) {
      const key = sessionKey(request.cookies);
      if (key) await redis.del(key);
      reply.clearCookie(sessionCookie, cookie);
      const login = request.cookies[flowCookie];
      if (login) await redis.del(`kordos:login:${digest(login)}`);
      reply.clearCookie(flowCookie, cookie);
    },
  };
}
