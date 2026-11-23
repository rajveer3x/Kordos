import { createHash } from "node:crypto";
import {
  connectorChangeSchema,
  googleCalendarReadRoles,
  googleRefreshTokenSchema,
  googleScopeIdSchema,
  timeZoneSchema,
  type ConnectorChange,
  type GoogleProvider,
  type GoogleSettings,
} from "@kordos/contracts";
import { z } from "zod";
import { ConnectorFailure } from "./adapter.js";

const providerPage = z.object({
  nextPageToken: z.string().min(1).max(2048).optional(),
});
const checkpoint = z.string().min(1).max(512);
const historyId = z.string().regex(/^\d{1,30}$/);
const eventDate = z.object({
  date: z.iso.date().optional(),
  dateTime: z.iso.datetime({ offset: true, local: true }).optional(),
  timeZone: timeZoneSchema.optional(),
});
const calendarPage = providerPage.extend({
  nextSyncToken: checkpoint.optional(),
  timeZone: timeZoneSchema.optional(),
  items: z
    .array(
      z.object({
        id: googleScopeIdSchema,
        status: z.string().optional(),
        summary: z.string().optional(),
        updated: z.iso.datetime({ offset: true }).optional(),
        start: eventDate.optional(),
      }),
    )
    .default([]),
});
const messageId = z.object({ id: googleScopeIdSchema });
const messageList = providerPage.extend({
  messages: z.array(messageId).default([]),
});
const messageRef = z.object({ message: messageId });
const labelChange = messageRef.extend({
  labelIds: z.array(googleScopeIdSchema),
});
const historyPage = providerPage.extend({
  historyId,
  history: z
    .array(
      z.object({
        messagesAdded: z.array(messageRef).default([]),
        messagesDeleted: z.array(messageRef).default([]),
        labelsAdded: z.array(labelChange).default([]),
        labelsRemoved: z.array(labelChange).default([]),
      }),
    )
    .default([]),
});
const labelIds = z.array(googleScopeIdSchema).default([]);
const bodyPart = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
  body: z.object({ data: z.string().optional() }).optional(),
});
type Part = z.infer<typeof bodyPart> & { parts?: Part[] };
const mimePart: z.ZodType<Part> = bodyPart.extend({
  get parts() {
    return z.array(mimePart).optional();
  },
});
const message = z.object({
  labelIds,
  internalDate: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number),
  snippet: z.string().default(""),
  payload: mimePart.optional(),
});

class ExpiredCursor extends Error {}

function clean(text: string, max: number) {
  return text
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

function plainText(part?: Part): string {
  if (
    !part ||
    part.filename ||
    part.mimeType === "message/rfc822" ||
    part.headers.some(
      ({ name, value }) =>
        name.toLowerCase() === "content-disposition" &&
        /^attachment\b/i.test(value),
    )
  )
    return "";
  if (part.mimeType === "text/plain" && part.body?.data)
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  if (!part.mimeType?.startsWith("multipart/")) return "";
  const parts = (part.parts ?? []).map(plainText).filter(Boolean);
  return part.mimeType === "multipart/alternative"
    ? (parts[0] ?? "")
    : parts.join("\n\n");
}

function calendarInstant(dateTime: string, timeZone: string) {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime)) return dateTime;
  const wallTime = Date.parse(dateTime + "Z");
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "longOffset",
  });
  let instant = wallTime;
  for (let i = 0; i < 3; i++) {
    const name = format
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value;
    const offset = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name ?? "");
    const seconds = offset
      ? (offset[1] === "-" ? -1 : 1) *
        (Number(offset[2]) * 3600 +
          Number(offset[3]) * 60 +
          Number(offset[4] ?? 0))
      : 0;
    const next = wallTime - seconds * 1000;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant).toISOString();
}

function upsert(
  externalId: string,
  observedAt: string,
  content: {
    title: string;
    body: string;
    calendarStart?: string;
  },
): ConnectorChange {
  return connectorChangeSchema.parse({
    kind: "upsert",
    externalId,
    observedAt,
    revisionKey: createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex"),
    url: null,
    ...content,
  });
}

function deleted(externalId: string, observedAt: string): ConnectorChange {
  return { kind: "delete", externalId, observedAt, revisionKey: "removed" };
}

export async function syncGoogle(
  settings: GoogleSettings,
  provider: GoogleProvider,
  refresh: string,
  scope: string,
  cursor: string | null,
) {
  const observed = new Date().toISOString();
  const deadline = AbortSignal.timeout(55_000);
  async function read<T>(
    url: string | URL,
    schema: z.ZodType<T>,
    options: RequestInit = {},
    expiresOn?: number,
  ) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(6000)]),
      });
    } catch {
      throw new ConnectorFailure("provider_unavailable");
    }
    if (!response.ok) {
      if (response.status === expiresOn) {
        await response.body?.cancel().catch(() => {});
        throw new ExpiredCursor();
      }
      if (response.status === 400 && url === settings.endpoints.token) {
        const error = z
          .object({ error: z.string() })
          .safeParse(await response.json().catch(() => null));
        throw new ConnectorFailure(
          error.success && error.data.error === "invalid_grant"
            ? "credential_revoked"
            : "provider_unavailable",
        );
      }
      if (response.status === 403) {
        const error = z
          .object({
            error: z.object({
              errors: z.array(z.object({ reason: z.string() })).default([]),
            }),
          })
          .safeParse(await response.json().catch(() => null));
        const reasons = error.success
          ? error.data.error.errors.map(({ reason }) => reason)
          : [];
        if (
          reasons.some((reason) =>
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "quotaExceeded",
            ].includes(reason),
          )
        )
          throw new ConnectorFailure("provider_unavailable");
        throw new ConnectorFailure("scope_unavailable");
      }
      await response.body?.cancel().catch(() => {});
      if (response.status === 401)
        throw new ConnectorFailure("credential_revoked");
      if (response.status === 404 || response.status === 410)
        throw new ConnectorFailure("scope_unavailable");
      throw new ConnectorFailure(
        response.status === 429 || response.status >= 500
          ? "provider_unavailable"
          : "invalid_batch",
      );
    }
    const stream = response.body?.getReader();
    if (!stream) throw new ConnectorFailure("invalid_batch");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await stream.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4_000_000) throw new ConnectorFailure("invalid_batch");
        chunks.push(value);
      }
    } catch (error) {
      await stream.cancel().catch(() => {});
      if (error instanceof ConnectorFailure) throw error;
      throw new ConnectorFailure("provider_unavailable");
    }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  const { access_token } = await read(
    settings.endpoints.token,
    z.object({ access_token: googleRefreshTokenSchema }),
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        refresh_token: googleRefreshTokenSchema.parse(refresh),
      }),
    },
  );
  const headers = { Authorization: `Bearer ${access_token}` };

  async function pages<T extends z.infer<typeof providerPage>>(
    url: URL,
    schema: z.ZodType<T>,
    collect: (page: T) => void,
    expiresOn?: number,
  ) {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const page = await read(url, schema, { headers }, expiresOn);
      collect(page);
      if (!page.nextPageToken) return page;
      if (seen.has(page.nextPageToken)) break;
      seen.add(page.nextPageToken);
      url.searchParams.set("pageToken", page.nextPageToken);
    }
    throw new ConnectorFailure("invalid_batch");
  }

  async function calendar(syncToken: string | null) {
    const entitlement = new URL(
      `users/me/calendarList/${encodeURIComponent(scope)}`,
      settings.endpoints.calendar,
    );
    entitlement.searchParams.set("fields", "id,accessRole,timeZone");
    const selected = await read(
      entitlement,
      z.object({
        id: googleScopeIdSchema,
        accessRole: z.string(),
        timeZone: timeZoneSchema.optional(),
      }),
      { headers },
    );
    if (
      selected.id !== scope ||
      !googleCalendarReadRoles.has(selected.accessRole)
    )
      throw new ConnectorFailure("scope_unavailable");
    const url = new URL(
      `calendars/${encodeURIComponent(scope)}/events`,
      settings.endpoints.calendar,
    );
    url.search = new URLSearchParams({
      showDeleted: "true",
      maxResults: "250",
      fields:
        "nextPageToken,nextSyncToken,timeZone,items(id,status,summary,updated,start)",
      ...(syncToken ? { syncToken } : {}),
    }).toString();
    const changes = new Map<string, ConnectorChange>();
    const final = await pages(
      url,
      calendarPage,
      (page) => {
        for (const event of page.items) {
          if (event.status === "cancelled") {
            changes.set(event.id, deleted(event.id, event.updated ?? observed));
            continue;
          }
          const timeZone =
            event.start?.timeZone ??
            page.timeZone ??
            selected.timeZone ??
            "UTC";
          const start =
            event.start?.dateTime ??
            (event.start?.date && event.start.date + "T00:00:00");
          if (!start) throw new ConnectorFailure("invalid_batch");
          const startsAt = calendarInstant(start, timeZone);
          changes.set(
            event.id,
            upsert(event.id, event.updated ?? observed, {
              title: clean(event.summary ?? "", 160) || "Calendar event",
              body: "",
              calendarStart: startsAt,
            }),
          );
        }
        if (changes.size > 5000) throw new ConnectorFailure("invalid_batch");
      },
      syncToken ? 410 : undefined,
    );
    if (!final.nextSyncToken) throw new ConnectorFailure("invalid_batch");
    return { changes: [...changes.values()], checkpoint: final.nextSyncToken };
  }

  function gmailUrl(resource: string, query?: Record<string, string>) {
    const url = new URL(resource, settings.endpoints.gmail);
    if (query) url.search = new URLSearchParams(query).toString();
    return url;
  }

  async function gmail(startHistoryId: string | null) {
    const label = await read(
      gmailUrl(`labels/${encodeURIComponent(scope)}`, { fields: "id,type" }),
      z.object({ id: googleScopeIdSchema, type: z.string() }),
      { headers },
    );
    if (label.id !== scope || label.type !== "user")
      throw new ConnectorFailure("scope_unavailable");
    const ids = new Set<string>();
    function add(id: string) {
      ids.add(id);
      if (ids.size > 1000) throw new ConnectorFailure("invalid_batch");
    }
    let nextHistoryId: string;
    if (startHistoryId) {
      const url = gmailUrl("history", {
        startHistoryId: historyId.parse(startHistoryId),
        maxResults: "500",
      });
      const final = await pages(
        url,
        historyPage,
        (page) => {
          for (const entry of page.history) {
            for (const row of [
              ...entry.messagesAdded,
              ...entry.messagesDeleted,
            ])
              add(row.message.id);
            for (const row of [...entry.labelsAdded, ...entry.labelsRemoved]) {
              if (
                row.labelIds.includes(scope) ||
                row.labelIds.some((id) => id === "TRASH" || id === "SPAM")
              )
                add(row.message.id);
            }
          }
        },
        404,
      );
      nextHistoryId = final.historyId;
    } else {
      // Fetch the watermark before listing, so changes during the rebuild appear in the next incremental sync.
      const profile = await read(
        gmailUrl("profile", { fields: "historyId" }),
        z.object({ historyId }),
        { headers },
      );
      nextHistoryId = profile.historyId;
      await pages(
        gmailUrl("messages", { labelIds: scope, maxResults: "500" }),
        messageList,
        (page) => page.messages.forEach(({ id }) => add(id)),
      );
    }

    const inScope = (labels: string[]) =>
      labels.includes(scope) &&
      !labels.includes("TRASH") &&
      !labels.includes("SPAM");
    async function load(id: string) {
      const path = `messages/${encodeURIComponent(id)}`;
      try {
        if (startHistoryId) {
          const metadata = await read(
            gmailUrl(path, { format: "minimal", fields: "labelIds" }),
            z.object({ labelIds }),
            { headers },
            404,
          );
          if (!inScope(metadata.labelIds)) return deleted(id, observed);
        }
        const item = await read(
          gmailUrl(path, {
            format: "full",
            fields: "labelIds,internalDate,snippet,payload",
          }),
          message,
          { headers },
          404,
        );
        if (!inScope(item.labelIds)) return deleted(id, observed);
        const subject = item.payload?.headers.find(
          ({ name }) => name.toLowerCase() === "subject",
        )?.value;
        return upsert(id, new Date(item.internalDate).toISOString(), {
          title: clean(subject ?? "", 240) || "Gmail message",
          body: clean(plainText(item.payload) || item.snippet, 16000),
        });
      } catch (error) {
        if (error instanceof ExpiredCursor) return deleted(id, observed);
        throw error;
      }
    }

    const changes: ConnectorChange[] = [];
    const work = [...ids];
    let bytes = 0;
    for (let i = 0; i < work.length; i += 12) {
      const batch = await Promise.all(work.slice(i, i + 12).map(load));
      bytes += Buffer.byteLength(JSON.stringify(batch));
      if (bytes > 4_000_000) throw new ConnectorFailure("invalid_batch");
      changes.push(...batch);
    }
    return { changes, checkpoint: nextHistoryId };
  }

  const sync = provider === "calendar" ? calendar : gmail;
  if (cursor) {
    try {
      return {
        ...(await sync(cursor)),
        rebuild: false,
        audience: "private" as const,
      };
    } catch (error) {
      if (!(error instanceof ExpiredCursor)) throw error;
    }
  }
  return { ...(await sync(null)), rebuild: true, audience: "private" as const };
}
