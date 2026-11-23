import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  connectorDirectorySchema,
  googleAuthorizationSchema,
  googleChoicesSchema,
  googleIntentSchema,
  googlePermissions,
  googleCalendarReadRoles,
  googleRefreshTokenSchema,
  googleScopeChoiceSchema,
  googleScopeIdSchema,
  googleSelectionSchema,
  googleStartSchema,
  googleSubjectSchema,
  idSchema,
  type GoogleProvider,
  type GoogleSettings,
} from "@kordos/contracts";
import { sealConnectorCredential } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";
import { connectorWriteResult, type ConnectorStore } from "./routes.js";

const googlePath = "/workspaces/:workspaceId/connectors/google";
const callbackPath = "/connectors/google/callback";
const workspaceParams = z.object({ workspaceId: idSchema });
const intentParams = workspaceParams.extend({ intent: googleIntentSchema });
const callbackQuery = z.object({
  state: googleIntentSchema,
  code: z.string().min(1).max(4096).optional(),
  error: z.string().optional(),
});
const storedIntent = googleStartSchema.extend({
  actor: idSchema,
  workspaceId: idSchema,
  verifier: z.string(),
  session: z.string(),
});
const storedGrant = googleChoicesSchema.extend({
  actor: idSchema,
  workspaceId: idSchema,
  subject: googleSubjectSchema,
  session: z.string(),
  credential: z.string(),
});
const tokens = z.object({
  access_token: googleRefreshTokenSchema,
  refresh_token: googleRefreshTokenSchema,
  scope: z.string(),
});
const labels = z.object({
  labels: z
    .array(
      z.object({
        id: googleScopeIdSchema,
        name: z.string(),
        type: z.string(),
      }),
    )
    .default([]),
});
const calendarList = z.object({
  items: z
    .array(
      z.object({
        id: googleScopeIdSchema,
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        accessRole: z.string(),
      }),
    )
    .default([]),
  nextPageToken: z.string().min(1).max(2048).optional(),
});

async function providerJson(url: string | URL, options: RequestInit) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Google request failed");
  }
  return (await response.json()) as unknown;
}

async function listScopes(
  provider: GoogleProvider,
  token: string,
  settings: GoogleSettings,
) {
  const headers = { Authorization: `Bearer ${token}` };
  if (provider === "gmail") {
    const result = labels.parse(
      await providerJson(new URL("labels", settings.endpoints.gmail), {
        headers,
      }),
    );
    return result.labels
      .filter((label) => label.type === "user")
      .map(({ id, name }) =>
        googleScopeChoiceSchema.parse({
          id,
          name: name.trim().slice(0, 240) || id.slice(0, 240),
        }),
      );
  }

  const scopes = new Map<string, string>();
  const url = new URL("users/me/calendarList", settings.endpoints.calendar);
  url.searchParams.set("minAccessRole", "reader");
  url.searchParams.set("maxResults", "250");
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const result = calendarList.parse(await providerJson(url, { headers }));
    for (const item of result.items) {
      if (!googleCalendarReadRoles.has(item.accessRole)) continue;
      const name = item.summaryOverride || item.summary || item.id;
      scopes.set(item.id, name.trim().slice(0, 240) || item.id.slice(0, 240));
    }
    const next = result.nextPageToken;
    if (!next) return [...scopes].map(([id, name]) => ({ id, name }));
    if (seen.has(next)) break;
    seen.add(next);
    url.searchParams.set("pageToken", next);
  }
  throw new Error("Unable to list Google calendars");
}

export function registerGoogle(
  api: FastifyInstance,
  db: ConnectorStore,
  requireActor: (request: FastifyRequest) => Promise<string>,
  sessionKey: (cookies: FastifyRequest["cookies"]) => string | undefined,
  redis: Redis,
  origin: URL,
  settings: GoogleSettings,
) {
  const redirectUri = new URL("/api" + callbackPath, origin).href;
  const intentKey = (id: string) => `kordos:google:oauth:${id}`;
  const grantKey = (id: string) => `kordos:google:selection:${id}`;

  async function directory(actor: string, workspaceId: string) {
    const value = await db.list([actor, workspaceId]);
    if (!value) throw unavailable();
    return connectorDirectorySchema.parse({
      ...value,
      enabled: true,
      googleEnabled: true,
      fixtureEnabled: false,
      githubInstallations: [],
    });
  }

  api.post(googlePath + "/start", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const input = parse(googleStartSchema, request.body);
    const available = await directory(actor, workspaceId);
    if (input.reconnect) {
      const { id, version } = input.reconnect;
      if (
        !available.items.some(
          (item) =>
            item.id === id &&
            item.version === version &&
            item.canConfigure &&
            item.provider === input.provider &&
            item.status !== "disconnected" &&
            item.mappings.length > 0,
        )
      )
        throw unavailable();
    } else if (!available.destinations.length) {
      throw unavailable();
    }

    const session = sessionKey(request.cookies);
    if (!session) throw unavailable();
    const state = randomUUID();
    const verifier = randomBytes(32).toString("base64url");
    await redis.set(
      intentKey(state),
      JSON.stringify({ ...input, actor, workspaceId, verifier, session }),
      "EX",
      600,
    );
    const url = new URL(settings.endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ["openid", ...googlePermissions[input.provider]].join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return googleAuthorizationSchema.parse({ url: url.href });
  });

  api.get(callbackPath, async (request, reply) => {
    const actor = await requireActor(request);
    const { state, code, error } = parse(callbackQuery, request.query);
    const key = intentKey(state);
    const raw = await redis.get(key);
    if (!raw) throw unavailable();
    const intent = storedIntent.parse(JSON.parse(raw));
    const session = sessionKey(request.cookies);
    if (
      !session ||
      intent.session !== session ||
      intent.actor !== actor ||
      !(await redis.getdel(key))
    )
      throw unavailable();

    const { workspaceId, provider, reconnect } = intent;
    const location = `/w/${workspaceId}/settings`;
    if (error || !code)
      return reply.redirect(location + "?googleError=consent#connectors");
    try {
      await directory(actor, workspaceId);
      const token = tokens.parse(
        await providerJson(settings.endpoints.token, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: settings.clientId,
            client_secret: settings.clientSecret,
            redirect_uri: redirectUri,
            code_verifier: intent.verifier,
            code,
          }),
        }),
      );
      const granted = new Set(token.scope.split(/\s+/));
      if (googlePermissions[provider].some((scope) => !granted.has(scope)))
        throw unavailable();
      const account = z.object({ sub: googleSubjectSchema }).parse(
        await providerJson(settings.endpoints.userInfo, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
      );
      const credential = sealConnectorCredential(
        settings.key,
        workspaceId,
        reconnect?.id ?? state,
        token.refresh_token,
      );
      if (reconnect) {
        const input = {
          action: "reconnect",
          expectedVersion: reconnect.version,
          mutationId: state,
          googleSubject: account.sub,
        };
        connectorWriteResult(
          await db.manage(
            [actor, workspaceId],
            reconnect.id,
            input,
            credential,
            state,
          ),
        );
        return reply.redirect(location + "#connectors");
      }

      const scopes = await listScopes(provider, token.access_token, settings);
      const value = storedGrant.parse({
        workspaceId,
        actor,
        provider,
        scopes,
        subject: account.sub,
        session,
        credential,
      });
      await redis.set(grantKey(state), JSON.stringify(value), "EX", 600);
      return reply.redirect(
        location + "?googleSelection=" + state + "#connectors",
      );
    } catch (failure) {
      const reason =
        failure instanceof IdentityError && failure.code === "conflict"
          ? "reconnect"
          : "authorization";
      return reply.redirect(
        location + "?googleError=" + reason + "#connectors",
      );
    }
  });

  async function grant(
    actor: string,
    workspaceId: string,
    intent: string,
    request: FastifyRequest,
  ) {
    await directory(actor, workspaceId);
    const raw = await redis.get(grantKey(intent));
    if (!raw) throw unavailable();
    const saved = storedGrant.parse(JSON.parse(raw));
    if (
      saved.workspaceId !== workspaceId ||
      saved.actor !== actor ||
      saved.session !== sessionKey(request.cookies)
    )
      throw unavailable();
    return saved;
  }

  api.get(googlePath + "/:intent", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, intent } = parse(intentParams, request.params);
    return googleChoicesSchema.parse(
      await grant(actor, workspaceId, intent, request),
    );
  });

  api.post(googlePath + "/:intent", async (request, reply) => {
    const actor = await requireActor(request);
    const { workspaceId, intent } = parse(intentParams, request.params);
    const selection = parse(googleSelectionSchema, request.body);
    const saved = await grant(actor, workspaceId, intent, request);
    if (!saved.scopes.some(({ id }) => id === selection.scope))
      throw unavailable();
    const input = {
      ...selection,
      action: "create",
      mutationId: intent,
      provider: saved.provider,
      googleSubject: saved.subject,
      label: saved.provider === "calendar" ? "Google Calendar" : "Gmail",
      audience: "private",
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = connectorWriteResult(
      await db.manage(
        [actor, workspaceId],
        intent,
        input,
        saved.credential,
        fingerprint,
      ),
    );
    return reply.code(201).send(result);
  });
}
