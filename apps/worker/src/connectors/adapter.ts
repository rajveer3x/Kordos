import {
  connectorChangeSchema,
  connectorEntitlementSchema,
  connectorPageSchema,
  type ConnectorChange,
  type connectorIssueSchema,
} from "@kordos/contracts";
import type { z } from "zod";

type Issue = z.infer<typeof connectorIssueSchema>;
export class ConnectorFailure extends Error {
  constructor(readonly issue: Issue) {
    super(issue);
  }
}
class ExpiredCheckpoint extends Error {}

export interface ConnectorAdapter {
  entitlement(token: string, scope: string): Promise<"project" | "private">;
  sync(
    token: string,
    scope: string,
    checkpoint: string,
  ): Promise<{ changes: ConnectorChange[]; checkpoint: string }>;
  reconcile(
    token: string,
    scope: string,
  ): Promise<{ changes: ConnectorChange[]; checkpoint: string }>;
  normalize(changes: unknown[]): ConnectorChange[];
}

export function fixtureAdapter(endpoint: string): ConnectorAdapter {
  const base = endpoint.replace(/\/$/, "") + "/";
  async function read(path: string, token: string) {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new ConnectorFailure("provider_unavailable");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      switch (response.status) {
        case 401:
        case 403:
          throw new ConnectorFailure("credential_revoked");
        case 404:
          throw new ConnectorFailure("scope_unavailable");
        case 410:
          throw new ExpiredCheckpoint();
        case 429:
          throw new ConnectorFailure("provider_unavailable");
        default:
          throw new ConnectorFailure(
            response.status >= 500 ? "provider_unavailable" : "invalid_batch",
          );
      }
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorFailure("invalid_batch");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) throw new ConnectorFailure("invalid_batch");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ConnectorFailure) throw error;
      throw new ConnectorFailure("provider_unavailable");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ConnectorFailure("invalid_batch");
    }
  }

  async function pages(
    token: string,
    scope: string,
    checkpoint: string | null,
  ) {
    const changes: ConnectorChange[] = [];
    const seen = new Set<string>();
    const query = new URLSearchParams(
      checkpoint ? { checkpoint } : { rebuild: "1" },
    );
    let bytes = 0;
    for (let page = 0; page < 10; page++) {
      const data = await read(
        `scopes/${encodeURIComponent(scope)}/changes?${query}`,
        token,
      );
      const parsed = connectorPageSchema.safeParse(data);
      if (!parsed.success) throw new ConnectorFailure("invalid_batch");
      bytes += Buffer.byteLength(JSON.stringify(parsed.data.changes));
      if (bytes > 3_000_000) throw new ConnectorFailure("invalid_batch");
      changes.push(...parsed.data.changes);
      if (parsed.data.checkpoint !== null)
        return { changes, checkpoint: parsed.data.checkpoint };
      const next = parsed.data.nextPage;
      if (next === null || seen.has(next))
        throw new ConnectorFailure("invalid_batch");
      seen.add(next);
      query.set("page", next);
    }
    throw new ConnectorFailure("invalid_batch");
  }

  return {
    async entitlement(token, scope) {
      const value = connectorEntitlementSchema.safeParse(
        await read(`scopes/${encodeURIComponent(scope)}/entitlement`, token),
      );
      if (!value.success) throw new ConnectorFailure("invalid_batch");
      return value.data.audience;
    },
    sync: pages,
    reconcile: (token, scope) => pages(token, scope, null),
    normalize: (changes) =>
      changes.map((change) => connectorChangeSchema.parse(change)),
  };
}

export async function syncConnector(
  adapter: ConnectorAdapter,
  token: string,
  scope: string,
  checkpoint: string | null,
) {
  if (checkpoint !== null) {
    try {
      return {
        ...(await adapter.sync(token, scope, checkpoint)),
        rebuild: false,
      };
    } catch (error) {
      if (!(error instanceof ExpiredCheckpoint)) throw error;
    }
  }
  return { ...(await adapter.reconcile(token, scope)), rebuild: true };
}
